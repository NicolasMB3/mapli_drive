import { EventEmitter } from 'events'
import { clipboard, powerMonitor, shell } from 'electron'
import type {
  DriveSettings,
  DriveState,
  EmployeeSpaceState,
  NewEmployeeInput,
  SpaceResult
} from '../shared/types'
import {
  api,
  ApiError,
  NetworkError,
  type DriveStatusPayload,
  type EmployeeSpacePendingPayload
} from './api'
import { WEB_URL } from './config'
import { DriveMount } from './drive-mount'
import { nextPrompt, promptIds, promptKey, pruneSnoozed } from './employee-space'
import { PairingFlow } from './pairing'
import { mountPathForOpen } from './platform'
import {
  clearDevice,
  loadDevice,
  loadSettings,
  saveDevice,
  saveSettings,
  updateDeviceContext,
  type Device
} from './session'
import { statsDelay, uploadsSettled, type UploadSnapshot } from './upload-watch'

/*
 * Le cœur de Mapli Drive : relie le poste (appairage), monte le lecteur, le garde en
 * vie (reconnexion après une coupure, une mise en veille, un plantage de rclone) et
 * tient la fenêtre et l'icône à jour (état, espace, envois, fichiers récents).
 */

const STATUS_REFRESH_MS = 5 * 60_000
const RECENT_REFRESH_MS = 60_000
const HEALTH_CHECK_MS = 10_000
/** Révision du coffre : de quoi voir un changement fait ailleurs en moins de 20 s. */
const REVISION_POLL_MS = 20_000
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
  /** Dernière révision du coffre vue, et dossiers de premier niveau du lecteur à ce moment-là. */
  private revision: string | null = null
  private topFolders: string[] | null = null
  private checkingRevision = false
  /** Espace salariés : proposé tant que la personne le gère (sinon, jusqu'à la prochaine connexion, plus rien). */
  private spaceAvailable = true
  private refreshingSpace = false
  /** Relecture demandée pendant une autre (un envoi a fini entre-temps) : relancée juste après. */
  private refreshSpaceAgain = false
  /** Transferts terminés par rclone au dernier relevé. */
  private completedTransfers = 0
  /** Propositions remises « à plus tard » (identifiants de demandes ou de dossiers). */
  private readonly snoozed = new Set<string>()
  /** Après une action réussie, la fenêtre reste le temps de son mot de confirmation. */
  private holdPopupUntil = 0
  private holdTimer: NodeJS.Timeout | null = null

  private readonly pairing = new PairingFlow({
    onUpdate: (pairing) => this.update({ pairing }),
    onApproved: (result) => void this.onPaired(result),
    onError: (message) => this.update({ error: message })
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
    employeeSpace: null,
    prompt: null
  }

  async init(): Promise<void> {
    DriveMount.killOrphans()

    powerMonitor.on('resume', () => setTimeout(() => void this.reconnectIfNeeded(), 3_000))
    this.timers.push(setInterval(() => void this.healthCheck(), HEALTH_CHECK_MS))
    this.timers.push(setInterval(() => void this.refreshStatus(), STATUS_REFRESH_MS))
    this.timers.push(setInterval(() => void this.refreshRecent(), RECENT_REFRESH_MS))
    this.timers.push(setInterval(() => void this.checkRevision(), REVISION_POLL_MS))

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

  private async onPaired(result: {
    token: string
    organization: { id: string; name: string }
    user: Device['user']
  }): Promise<void> {
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
      notice: null
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
        this.update({
          phase: 'error',
          error: `Vous n’avez pas accès au coffre-fort de ${status.organization.name}. Demandez l’accès à un administrateur.`
        })
        return
      }

      const path = await this.mount.mount(
        {
          davUrl: status.dav_url,
          finderUrl: status.finder_url,
          token: this.device.token,
          mountPoint: this.settings.mountPoint,
          cacheSizeGb: this.settings.cacheSizeGb
        },
        (code) => this.onMountExit(code)
      )

      this.retryCount = 0
      this.update({ phase: 'connected', mounted: true, mountPoint: path })
      // Nouveau montage : la première révision lue relit aussi l'arborescence de l'Explorateur.
      this.revision = null
      this.topFolders = null
      this.scheduleStats()
      void this.refreshRecent()
      this.spaceAvailable = true
      void this.refreshEmployeeSpace()
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

  /** Ouvre le coffre-fort sur le web, ou la page de son espace (liste fermée de pages). */
  openWeb(page: unknown = 'vault'): void {
    const path = page === 'storage' ? '/settings/facturation#stockage' : '/documents'
    void shell.openExternal(`${WEB_URL}${path}`)
  }

  dismissNotice(): void {
    this.update({ notice: null })
  }

  // ── Espace salariés (petite fenêtre) ────────────────────

  /** Publier dans l'espace du salarié les documents déposés (et le prévenir par e-mail). */
  publishEmployeeSpace(requestIds: string[], notify: boolean): Promise<SpaceResult> {
    return this.spaceAction((token) => api.employeeSpacePublish(token, requestIds, notify))
  }

  /** Ne pas les publier : ils restent classés dans le dossier, sans arriver chez le salarié. */
  discardEmployeeSpace(requestIds: string[]): Promise<SpaceResult> {
    return this.spaceAction((token) => api.employeeSpaceDiscard(token, requestIds))
  }

  /** Créer l'espace salarié de la personne dont on a créé le dossier à la main. */
  createEmployeeFromFolder(folderId: string, input: NewEmployeeInput): Promise<SpaceResult> {
    return this.spaceAction((token) => api.employeeSpaceCreateEmployee(token, folderId, input))
  }

  /** « Garder un simple dossier » : plus de proposition pour lui. */
  keepEmployeeFolder(folderId: string): Promise<SpaceResult> {
    return this.spaceAction((token) => api.employeeSpaceKeepFolder(token, folderId))
  }

  /** « Plus tard » : la fenêtre passe à la proposition suivante, ou se cache. */
  laterEmployeeSpace(): void {
    if (this.state.prompt) promptIds(this.state.prompt).forEach((id) => this.snoozed.add(id))
    this.holdPopupUntil = 0
    this.showNextPrompt(true)
  }

  /** Depuis la zone de notification : tout ce qui attend est reproposé. */
  showEmployeeSpace(): void {
    this.snoozed.clear()
    this.showNextPrompt(true)
  }

  /** Le dossier sur app.mapli.fr : seulement une adresse de Mapli. */
  openSpaceWeb(url: unknown): void {
    if (typeof url === 'string' && url.startsWith(`${WEB_URL}/`)) void shell.openExternal(url)
  }

  private async spaceAction(
    call: (token: string) => Promise<{ message: string }>
  ): Promise<SpaceResult> {
    if (!this.device) return { ok: false, message: 'Ce poste n’est pas relié à Mapli.' }
    try {
      const { message } = await call(this.device.token)
      // Relu tout de suite : la fenêtre passe à la suite (ou se cache, après sa confirmation).
      this.holdPopupUntil = Date.now() + 2_200
      this.applyEmployeeSpace(await api.employeeSpacePending(this.device.token))
      return { ok: true, message }
    } catch (error) {
      return { ok: false, message: this.message(error) }
    }
  }

  private async refreshEmployeeSpace(): Promise<void> {
    if (!this.device || this.state.phase !== 'connected' || !this.spaceAvailable) return
    // Une lecture part déjà, peut-être d'avant la fin de l'envoi : on relira juste après,
    // sans quoi le dépôt qui vient d'arriver attendrait le prochain passage (20 s).
    if (this.refreshingSpace) {
      this.refreshSpaceAgain = true
      return
    }
    this.refreshingSpace = true
    try {
      this.applyEmployeeSpace(await api.employeeSpacePending(this.device.token))
    } catch (error) {
      // La personne ne gère pas l'espace salarié, ou l'offre ne l'inclut pas : rien à proposer.
      if (error instanceof ApiError && [403, 404].includes(error.status)) {
        this.spaceAvailable = false
        this.update({ employeeSpace: null, prompt: null })
        this.emit('prompt-done')
      }
    } finally {
      this.refreshingSpace = false
      if (this.refreshSpaceAgain) {
        this.refreshSpaceAgain = false
        void this.refreshEmployeeSpace()
      }
    }
  }

  private applyEmployeeSpace(payload: EmployeeSpacePendingPayload): void {
    const space: EmployeeSpaceState = {
      groups: payload.data,
      newFolders: payload.new_folders,
      seats: payload.seats
    }
    pruneSnoozed(space, this.snoozed)
    this.update({ employeeSpace: space })
    this.showNextPrompt(false)
  }

  /** Met à jour la proposition ; la fenêtre s'ouvre pour une nouvelle, se cache s'il n'y en a plus. */
  private showNextPrompt(force: boolean): void {
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = null
    const previous = promptKey(this.state.prompt)
    const prompt = nextPrompt(this.state.employeeSpace, this.snoozed)
    this.update({ prompt })
    if (!prompt) {
      const wait = this.holdPopupUntil - Date.now()
      if (wait > 0) this.holdTimer = setTimeout(() => this.showNextPrompt(false), wait)
      else this.emit('prompt-done')
    } else if (force || promptKey(prompt) !== previous) {
      this.emit('prompt')
    }
  }

  getSettings(): DriveSettings {
    return this.settings
  }

  async setSettings(next: Partial<DriveSettings>): Promise<DriveSettings> {
    const previous = this.settings
    this.settings = saveSettings(next)
    this.update({ mountPoint: this.settings.mountPoint })

    const remount =
      this.state.phase === 'connected' &&
      (previous.mountPoint !== this.settings.mountPoint ||
        previous.cacheSizeGb !== this.settings.cacheSizeGb)
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
        memberLimitBytes: status.storage.member_limit_bytes
      }
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
    this.update({
      phase: offline ? 'offline' : 'error',
      mounted: false,
      error: this.message(error)
    })
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
      employeeSpace: null,
      prompt: null
    })
    this.snoozed.clear()
    this.emit('prompt-done')
  }

  private onMountExit(code: number | null): void {
    // Arrêt inattendu de rclone : on remonte (avec temporisation).
    if (this.state.phase === 'connected') {
      this.update({
        phase: 'offline',
        mounted: false,
        error: code ? 'Le lecteur s’est arrêté. Reconnexion…' : null
      })
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
    if (
      this.device &&
      (this.state.phase === 'offline' ||
        (this.state.phase === 'connected' && !this.mount.isMounted()))
    ) {
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

  /**
   * Relève les envois de rclone (voir upload-watch) : un envoi terminé fait relire
   * l'espace salariés, et la petite fenêtre propose aussitôt de publier le fichier déposé.
   */
  private scheduleStats(): void {
    if (this.statsTimer) clearTimeout(this.statsTimer)
    if (this.state.phase !== 'connected') return
    this.statsTimer = setTimeout(
      async () => {
        const stats = await this.mount.stats()
        const previous = this.uploadSnapshot()
        this.completedTransfers = stats.completed
        // Rien ne part ni n'attend, comme au relevé précédent : l'état ne change pas (pas de
        // quoi redessiner l'icône et son menu toutes les 2,5 s).
        const unchanged =
          stats.pendingUploads === this.state.pendingUploads &&
          stats.transfers.length === 0 &&
          this.state.transfers.length === 0
        if (!unchanged) {
          this.update({ transfers: stats.transfers, pendingUploads: stats.pendingUploads })
        }
        if (uploadsSettled(previous, this.uploadSnapshot())) {
          void this.refreshRecent()
          // Un fichier vient d'arriver dans le dossier d'un salarié ? La fenêtre le propose.
          void this.refreshEmployeeSpace()
        }
        this.scheduleStats()
      },
      statsDelay(this.windowVisible, this.uploadSnapshot())
    )
  }

  private uploadSnapshot(): UploadSnapshot {
    return {
      transfers: this.state.transfers.length,
      pendingUploads: this.state.pendingUploads,
      completed: this.completedTransfers
    }
  }

  private async refreshStatus(): Promise<void> {
    if (!this.device || this.state.phase !== 'connected') return
    try {
      this.applyStatus(await api.driveStatus(this.device.token))
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.handleConnectError(error)
    }
  }

  /**
   * Le coffre a-t-il changé ailleurs (web, autre poste, partage) ? Si oui, et qu'aucun
   * envoi n'est en cours, le lecteur relit le serveur et l'Explorateur son arborescence
   * — sans quoi un dossier supprimé sur le web y reste affiché.
   */
  private async checkRevision(): Promise<void> {
    if (!this.device || this.state.phase !== 'connected' || this.checkingRevision) return
    this.checkingRevision = true
    try {
      const revision = await api.driveRevision(this.device.token)
      if (revision === this.revision) return
      // Des envois partent : on attend qu'ils soient finis (le prochain passage rafraîchira).
      if (this.state.pendingUploads > 0 || this.state.transfers.length > 0) return

      const first = this.revision === null
      this.revision = revision
      this.topFolders = await this.mount.refreshExplorer(first ? null : this.topFolders)
      if (!first) void this.refreshRecent()
      // Dépôt dans le dossier d'un salarié, dossier créé dans « Espace salariés », validation faite ailleurs.
      void this.refreshEmployeeSpace()
    } catch {
      // Hors ligne ou token révoqué : la surveillance de la connexion s'en occupe.
    } finally {
      this.checkingRevision = false
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
