import { EventEmitter } from 'events'
import { clipboard, powerMonitor, shell } from 'electron'
import type { DriveSettings, DriveState } from '../shared/types'
import { api, ApiError, NetworkError, type DriveStatusPayload } from './api'
import { WEB_URL } from './config'
import { DriveMount } from './drive-mount'
import { PairingFlow } from './pairing'
import { mountPathForOpen } from './platform'
import { clearDevice, loadDevice, loadSettings, saveDevice, saveSettings, updateDeviceContext, type Device } from './session'

/*
 * Le cœur de Mapli Drive : relie le poste (appairage), monte le lecteur, le garde en
 * vie (reconnexion après une coupure, une mise en veille, un plantage de rclone) et
 * tient la fenêtre et l'icône à jour (état, espace, envois, fichiers récents).
 */

const STATUS_REFRESH_MS = 5 * 60_000
const RECENT_REFRESH_MS = 60_000
const HEALTH_CHECK_MS = 10_000
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000]

export class DriveController extends EventEmitter {
  private readonly mount = new DriveMount()
  private device: Device | null = null
  private settings: DriveSettings = loadSettings()
  private retryCount = 0
  private retryTimer: NodeJS.Timeout | null = null
  private timers: NodeJS.Timeout[] = []
  private statsTimer: NodeJS.Timeout | null = null
  private connecting = false
  private windowVisible = false

  private readonly pairing = new PairingFlow({
    onUpdate: (pairing) => this.update({ pairing }),
    onApproved: (result) => void this.onPaired(result),
    onError: (message) => this.update({ error: message }),
  })

  state: DriveState = {
    phase: 'unpaired',
    pairing: null,
    device: null,
    mountPoint: this.settings.mountPoint,
    mounted: false,
    storage: null,
    permissions: null,
    transfers: [],
    pendingUploads: 0,
    recent: [],
    error: null,
    notice: null,
  }

  async init(): Promise<void> {
    DriveMount.killOrphans()

    powerMonitor.on('resume', () => setTimeout(() => void this.reconnectIfNeeded(), 3_000))
    this.timers.push(setInterval(() => void this.healthCheck(), HEALTH_CHECK_MS))
    this.timers.push(setInterval(() => void this.refreshStatus(), STATUS_REFRESH_MS))
    this.timers.push(setInterval(() => void this.refreshRecent(), RECENT_REFRESH_MS))

    this.device = loadDevice()
    if (!this.device) {
      this.update({ phase: 'unpaired' })
      return
    }

    this.update({ device: { organization: this.device.organization, user: this.device.user } })
    await this.connect()
  }

  /** La fenêtre est-elle visible ? Les transferts y sont suivis de plus près. */
  setWindowVisible(visible: boolean): void {
    this.windowVisible = visible
    this.scheduleStats()
    if (visible) void this.refreshRecent()
  }

  // ── Appairage ───────────────────────────────────────────

  async startPairing(): Promise<void> {
    this.update({ phase: 'pairing', error: null, notice: null, pairing: null })
    try {
      const pairing = await this.pairing.start()
      this.update({ pairing })
    } catch (error) {
      this.update({ phase: 'unpaired', error: this.message(error) })
    }
  }

  cancelPairing(): void {
    this.pairing.cancel()
    this.update({ phase: 'unpaired', pairing: null })
  }

  openVerification(): void {
    if (this.state.pairing) {
      clipboard.writeText(this.state.pairing.code)
      void shell.openExternal(this.state.pairing.url)
    }
  }

  private async onPaired(result: { token: string; organization: { id: string; name: string }; user: Device['user'] }): Promise<void> {
    try {
      saveDevice({ token: result.token, organization: result.organization, user: result.user })
    } catch (error) {
      this.update({ phase: 'error', error: this.message(error) })
      return
    }
    this.device = loadDevice()
    this.update({
      pairing: null,
      device: { organization: result.organization, user: result.user },
      notice: null,
    })
    await this.connect()
  }

  // ── Lecteur ─────────────────────────────────────────────

  async connect(): Promise<void> {
    if (!this.device || this.connecting) return
    this.connecting = true
    this.clearRetry()
    this.update({ phase: 'connecting', error: null })

    try {
      const status = await api.driveStatus(this.device.token)
      this.applyStatus(status)

      if (!status.permissions.view) {
        this.update({ phase: 'error', error: `Vous n’avez pas accès au coffre-fort de ${status.organization.name}. Demandez l’accès à un administrateur.` })
        return
      }

      const path = await this.mount.mount(
        {
          davUrl: status.dav_url,
          finderUrl: status.finder_url,
          token: this.device.token,
          mountPoint: this.settings.mountPoint,
          cacheSizeGb: this.settings.cacheSizeGb,
        },
        (code) => this.onMountExit(code),
      )

      this.retryCount = 0
      this.update({ phase: 'connected', mounted: true, mountPoint: path })
      this.scheduleStats()
      void this.refreshRecent()
    } catch (error) {
      this.handleConnectError(error)
    } finally {
      this.connecting = false
    }
  }

  async pause(): Promise<void> {
    this.clearRetry()
    await this.mount.unmount()
    this.update({ phase: 'paused', mounted: false, transfers: [], pendingUploads: 0 })
  }

  async resume(): Promise<void> {
    await this.connect()
  }

  /** Déconnecter ce poste : le token est révoqué côté Mapli et oublié ici. */
  async unpair(): Promise<void> {
    this.clearRetry()
    const token = this.device?.token
    await this.mount.unmount()
    if (token) {
      try {
        await api.disconnect(token)
      } catch {
        // Hors ligne : le token reste révocable depuis app.mapli.fr (Appareils connectés).
      }
    }
    this.forgetDevice(null)
  }

  openDrive(): void {
    if (this.mount.path) void shell.openPath(mountPathForOpen(this.mount.path))
  }

  openWeb(): void {
    void shell.openExternal(`${WEB_URL}/documents`)
  }

  dismissNotice(): void {
    this.update({ notice: null })
  }

  getSettings(): DriveSettings {
    return this.settings
  }

  async setSettings(next: Partial<DriveSettings>): Promise<DriveSettings> {
    const previous = this.settings
    this.settings = saveSettings(next)
    this.update({ mountPoint: this.settings.mountPoint })

    const remount = this.state.phase === 'connected'
      && (previous.mountPoint !== this.settings.mountPoint || previous.cacheSizeGb !== this.settings.cacheSizeGb)
    if (remount) {
      await this.mount.unmount()
      await this.connect()
    }

    return this.settings
  }

  /** Fermeture de l'application : démontage propre (envois terminés). */
  async shutdown(): Promise<void> {
    this.timers.forEach(clearInterval)
    this.clearRetry()
    if (this.statsTimer) clearTimeout(this.statsTimer)
    this.pairing.cancel()
    await this.mount.unmount()
  }

  killSync(): void {
    this.mount.killSync()
  }

  // ── Interne ─────────────────────────────────────────────

  private applyStatus(status: DriveStatusPayload): void {
    const context = { organization: status.organization, user: status.user }
    updateDeviceContext(context)
    this.update({
      device: context,
      permissions: status.permissions,
      storage: {
        usedBytes: status.storage.used_bytes,
        limitBytes: status.storage.limit_bytes,
        trashBytes: status.storage.trash_bytes,
        memberUsedBytes: status.storage.member_used_bytes,
        memberLimitBytes: status.storage.member_limit_bytes,
      },
    })
  }

  private handleConnectError(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) {
      // Token révoqué (Appareils connectés) ou expiré : le poste doit être relié à nouveau.
      void this.mount.unmount()
      this.forgetDevice('Ce poste a été déconnecté de Mapli. Reliez-le pour retrouver le lecteur.')
      return
    }

    if (error instanceof ApiError && error.status === 403) {
      this.update({ phase: 'error', mounted: false, error: error.message })
      return
    }

    const offline = error instanceof NetworkError
    this.update({ phase: offline ? 'offline' : 'error', mounted: false, error: this.message(error) })
    this.scheduleRetry()
  }

  private forgetDevice(notice: string | null): void {
    clearDevice()
    this.device = null
    this.update({
      phase: 'unpaired',
      device: null,
      mounted: false,
      storage: null,
      permissions: null,
      transfers: [],
      pendingUploads: 0,
      recent: [],
      error: null,
      notice,
    })
  }

  private onMountExit(code: number | null): void {
    // Arrêt inattendu de rclone : on remonte (avec temporisation).
    if (this.state.phase === 'connected') {
      this.update({ phase: 'offline', mounted: false, error: code ? 'Le lecteur s’est arrêté. Reconnexion…' : null })
      this.scheduleRetry()
    }
  }

  private async healthCheck(): Promise<void> {
    if (this.state.phase === 'connected' && !this.mount.isMounted()) {
      this.update({ phase: 'offline', mounted: false })
      this.scheduleRetry()
    }
  }

  private async reconnectIfNeeded(): Promise<void> {
    if (this.device && (this.state.phase === 'offline' || (this.state.phase === 'connected' && !this.mount.isMounted()))) {
      await this.connect()
    }
  }

  private scheduleRetry(): void {
    this.clearRetry()
    const delay = RETRY_DELAYS_MS[Math.min(this.retryCount, RETRY_DELAYS_MS.length - 1)]
    this.retryCount += 1
    this.retryTimer = setTimeout(() => void this.connect(), delay)
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private scheduleStats(): void {
    if (this.statsTimer) clearTimeout(this.statsTimer)
    if (this.state.phase !== 'connected') return
    const delay = this.windowVisible ? 1_500 : 15_000
    this.statsTimer = setTimeout(async () => {
      const stats = await this.mount.stats()
      const finished = this.state.transfers.length > 0 && stats.transfers.length === 0
      this.update({ transfers: stats.transfers, pendingUploads: stats.pendingUploads })
      if (finished) void this.refreshRecent()
      this.scheduleStats()
    }, delay)
  }

  private async refreshStatus(): Promise<void> {
    if (!this.device || this.state.phase !== 'connected') return
    try {
      this.applyStatus(await api.driveStatus(this.device.token))
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.handleConnectError(error)
    }
  }

  private async refreshRecent(): Promise<void> {
    if (!this.device || this.state.phase !== 'connected') return
    try {
      this.update({ recent: await api.recent(this.device.token) })
    } catch {
      // Liste indicative : une erreur passagère ne change rien.
    }
  }

  private message(error: unknown): string {
    return error instanceof Error && error.message ? error.message : 'Une erreur est survenue.'
  }

  private update(partial: Partial<DriveState>): void {
    this.state = { ...this.state, ...partial }
    this.emit('state', this.state)
  }
}
