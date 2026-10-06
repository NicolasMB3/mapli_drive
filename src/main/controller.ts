import { EventEmitter } from 'events'
import { app, clipboard, net, powerMonitor, shell } from 'electron'
import type {
  DriveSettings,
  DriveState,
  EmployeeSpaceState,
  NewEmployeeInput,
  SpaceResult
} from '../shared/types'
import { api, type DriveStatusPayload, type EmployeeSpacePendingPayload } from './api'
import { jittered, reconnectRetryDelay } from './backoff'
import { API_URL, WEB_URL } from './config'
import { DriveMount } from './drive-mount'
import { FolderNames, nextPrompt, promptIds, promptKey, pruneSnoozed } from './employee-space'
import { ApiError, NetworkError } from './errors'
import { LiveSync } from './live-sync'
import { PairingFlow } from './pairing'
import { mountPathForOpen } from './platform'
import { RealtimeClient } from './realtime'
import { openRealtimeSocket } from './realtime-socket'
import {
  clearDevice,
  clearRealtimeEndpoint,
  loadDevice,
  loadRealtimeEndpoint,
  loadSettings,
  saveDevice,
  saveRealtimeEndpoint,
  saveSettings,
  updateDeviceContext,
  type Device
} from './session'
import { changedKeys } from './state-diff'
import { statsDelay, uploadsSettled, type UploadSnapshot } from './upload-watch'
import { frenchOr, toUserMessage, type ErrorContext } from './user-message'

/*
 * Le cœur de Mapli Drive : relie le poste (appairage), monte le lecteur, le garde en
 * vie (reconnexion après une coupure, une mise en veille, un plantage de rclone) et
 * tient la fenêtre et l'icône à jour (état, espace, envois, fichiers récents). Les
 * changements faits ailleurs arrivent par la connexion temps réel (live-sync.ts).
 */

/** Santé du lecteur (port de contrôle de rclone), toutes les 30 s environ. */
const HEALTH_CHECK_MS = 30_000
/** Échecs consécutifs avant de remonter le lecteur. */
const HEALTH_FAILURES = 2
/** rclone a reçu un 401 : le token est vérifié, au plus une fois par minute. */
const TOKEN_CHECK_MS = 60_000

export class DriveController extends EventEmitter {
  private readonly mount = new DriveMount()
  private device: Device | null = null
  private settings: DriveSettings = loadSettings()
  private retryCount = 0
  private retryTimer: NodeJS.Timeout | null = null
  private healthTimer: NodeJS.Timeout | null = null
  private healthFailures = 0
  private statsTimer: NodeJS.Timeout | null = null
  private connecting = false
  private windowVisible = false
  /** Erreurs de rclone au dernier relevé, et dernière vérification du token. */
  private rcloneErrors = 0
  private tokenCheckedAt = 0
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
  /** Nouveaux dossiers : proposés une fois nommés (pas « Nouveau dossier ») et leur nom posé. */
  private readonly folderNames = new FolderNames()
  private folderTimer: NodeJS.Timeout | null = null

  private readonly pairing = new PairingFlow({
    onUpdate: (pairing) => this.update({ pairing }),
    onApproved: (result) => void this.onPaired(result),
    onError: (message) => this.update({ error: message })
  })

  /** Changements faits ailleurs : temps réel, interrogation de secours sinon. */
  private readonly live = new LiveSync(
    {
      fetchRevision: () => this.withToken((token) => api.driveRevision(token)),
      refreshStatus: async () => this.applyStatus(await this.withToken(api.driveStatus)),
      fetchFolders: (etag) => this.withToken((token) => api.driveFolders(token, etag)),
      invalidate: (plan) => this.mount.invalidate(plan),
      busy: () => this.mount.busy(),
      windowVisible: () => this.windowVisible,
      refreshRecent: () => void this.refreshRecent(),
      refreshPending: () => void this.refreshEmployeeSpace(),
      revoked: () => this.onRevoked(),
      online: () => net.isOnline()
    },
    {
      createRealtime: () =>
        new RealtimeClient({
          version: app.getVersion(),
          authorize: (socketId) => this.withToken((token) => api.realtimeAuth(token, socketId)),
          open: (url, handlers) =>
            openRealtimeSocket(url, handlers, {
              userAgent: `MapliDrive/${app.getVersion()}`,
              origin: WEB_URL
            }),
          loadEndpoint: loadRealtimeEndpoint,
          saveEndpoint: saveRealtimeEndpoint,
          clearEndpoint: clearRealtimeEndpoint,
          allowInsecure: API_URL.startsWith('http://'),
          online: () => net.isOnline(),
          log: (message) => console.info(`[Mapli Drive] ${message}`)
        }),
      isLocked: () => powerMonitor.getSystemIdleState(60) === 'locked',
      log: (message) => console.info(`[Mapli Drive] ${message}`)
    }
  )

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
    // rclone resté d'une session interrompue : arrêté avant le montage, sans bloquer.
    await DriveMount.cleanupOrphans()

    // Veille et écran verrouillé : plus rien ne part ; au retour, reconnexion étalée.
    powerMonitor.on('suspend', () => this.live.setSuspended(true))
    powerMonitor.on('resume', () => {
      this.live.setSuspended(false)
      setTimeout(() => void this.reconnectIfNeeded(), 3_000)
    })
    powerMonitor.on('lock-screen', () => this.live.setLocked(true))
    powerMonitor.on('unlock-screen', () => this.live.setLocked(false))
    this.scheduleHealth()

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
    if (visible) this.live.windowShown()
  }

  // ── Appairage ───────────────────────────────────────────

  async startPairing(): Promise<void> {
    this.update({ phase: 'pairing', error: null, notice: null, pairing: null })
    try {
      const pairing = await this.pairing.start()
      this.update({ pairing })
    } catch (error) {
      this.update({ phase: 'unpaired', error: this.message(error, 'pairing') })
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
      this.update({ phase: 'error', error: this.message(error, 'pairing') })
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
    this.live.stop()
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
      this.healthFailures = 0
      this.rcloneErrors = 0
      this.update({ phase: 'connected', mounted: true, mountPoint: path })
      // Nouveau montage : la synchronisation repart (la première révision lue relit aussi
      // l'arborescence de l'Explorateur).
      this.live.start()
      this.scheduleStats()
      if (this.windowVisible) void this.refreshRecent()
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
    this.live.stop()
    await this.mount.unmount()
    this.update({ phase: 'paused', mounted: false, transfers: [], pendingUploads: 0 })
  }

  async resume(): Promise<void> {
    await this.connect()
  }

  /** Déconnecter ce poste : le token est révoqué côté Mapli et oublié ici. */
  async unpair(): Promise<void> {
    this.clearRetry()
    this.live.stop()
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
    const published =
      requestIds.length > 1 ? `${requestIds.length} documents publiés` : 'Document publié'
    return this.spaceAction(
      (token) => api.employeeSpacePublish(token, requestIds, notify),
      `${published} dans son espace${notify ? ', avec un e-mail de notification' : ''}.`
    )
  }

  /** Ne pas les publier : ils restent classés dans le dossier, sans arriver chez le salarié. */
  discardEmployeeSpace(requestIds: string[]): Promise<SpaceResult> {
    return this.spaceAction(
      (token) => api.employeeSpaceDiscard(token, requestIds),
      requestIds.length > 1
        ? 'Documents non publiés : ils restent classés dans le coffre.'
        : 'Document non publié : il reste classé dans le coffre.'
    )
  }

  /** Créer l'espace salarié de la personne dont on a créé le dossier à la main. */
  createEmployeeFromFolder(folderId: string, input: NewEmployeeInput): Promise<SpaceResult> {
    return this.spaceAction(
      (token) => api.employeeSpaceCreateEmployee(token, folderId, input),
      'Espace salarié créé : un lien d’activation a été envoyé par e-mail.'
    )
  }

  /** « Garder un simple dossier » : plus de proposition pour lui. */
  keepEmployeeFolder(folderId: string): Promise<SpaceResult> {
    return this.spaceAction(
      (token) => api.employeeSpaceKeepFolder(token, folderId),
      'Ce dossier reste un simple dossier.'
    )
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

  /**
   * Une action de la petite fenêtre. `done` : le mot de confirmation, si le serveur n'en
   * donne pas en français.
   */
  private async spaceAction(
    call: (token: string) => Promise<{ message: string }>,
    done: string
  ): Promise<SpaceResult> {
    if (!this.device) return { ok: false, message: 'Ce poste n’est pas relié à Mapli.' }
    try {
      const { message } = await call(this.device.token)
      // Relu tout de suite : la fenêtre passe à la suite (ou se cache, après sa confirmation).
      this.holdPopupUntil = Date.now() + 2_200
      this.applyEmployeeSpace(await api.employeeSpacePending(this.device.token))
      return { ok: true, message: frenchOr(message, done) }
    } catch (error) {
      return { ok: false, message: this.message(error, 'space') }
    }
  }

  private async refreshEmployeeSpace(): Promise<void> {
    if (!this.device || this.state.phase !== 'connected' || !this.spaceAvailable) return
    // Une lecture part déjà, peut-être d'avant la fin de l'envoi : on relira juste après,
    // sans quoi le dépôt qui vient d'arriver attendrait le prochain signal.
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
      } else if (error instanceof ApiError && error.status === 401) {
        this.onRevoked()
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
    this.folderNames.update(space.newFolders)
    this.update({ employeeSpace: space })
    this.showNextPrompt(false)
  }

  /** Met à jour la proposition ; la fenêtre s'ouvre pour une nouvelle, se cache s'il n'y en a plus. */
  private showNextPrompt(force: boolean): void {
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = null
    if (this.folderTimer) clearTimeout(this.folderTimer)
    this.folderTimer = null
    const previous = promptKey(this.state.prompt)
    const prompt = nextPrompt(this.state.employeeSpace, this.snoozed, this.folderNames.ready)
    // Un dossier dont le nom vient d'être tapé attend encore : on y revient à la fin de l'attente.
    const settledAt = this.folderNames.nextReadyAt()
    if (settledAt !== null && this.state.employeeSpace) {
      this.folderTimer = setTimeout(
        () => this.showNextPrompt(false),
        Math.max(0, settledAt - Date.now()) + 50
      )
    }
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
      this.live.stop()
      await this.mount.unmount()
      await this.connect()
    }

    return this.settings
  }

  /** Fermeture de l'application : démontage propre (envois terminés). */
  async shutdown(): Promise<void> {
    this.live.stop()
    if (this.healthTimer) clearTimeout(this.healthTimer)
    this.clearRetry()
    if (this.statsTimer) clearTimeout(this.statsTimer)
    this.pairing.cancel()
    await this.mount.unmount()
  }

  killSync(): void {
    this.mount.killSync()
  }

  // ── Interne ─────────────────────────────────────────────

  /** Appel de l'API avec le token du poste (rejeté si le poste n'est plus relié). */
  private withToken<T>(call: (token: string) => Promise<T>): Promise<T> {
    const token = this.device?.token
    return token ? call(token) : Promise.reject(new Error('poste non relié'))
  }

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
      this.onRevoked()
      return
    }

    if (error instanceof ApiError && error.status === 403) {
      this.update({ phase: 'error', mounted: false, error: this.message(error, 'connect') })
      return
    }

    const offline = error instanceof NetworkError
    this.update({
      phase: offline ? 'offline' : 'error',
      mounted: false,
      error: this.message(error, 'connect')
    })
    this.scheduleRetry(error)
  }

  /**
   * Token révoqué (Appareils connectés : annoncé en temps réel, ou un 401) ou expiré : le
   * lecteur est démonté sans attendre — rclone réessaierait en vain — et le poste doit
   * être relié à nouveau.
   */
  private onRevoked(): void {
    if (!this.device) return
    this.clearRetry()
    this.live.stop()
    void this.mount.unmount(false)
    this.forgetDevice('Ce poste a été déconnecté de Mapli. Reliez-le pour retrouver le lecteur.')
  }

  private forgetDevice(notice: string | null): void {
    this.live.stop()
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
      this.live.stop()
      this.update({
        phase: 'offline',
        mounted: false,
        error: code ? 'Le lecteur s’est arrêté. Reconnexion…' : null
      })
      this.scheduleRetry()
    }
  }

  private scheduleHealth(): void {
    if (this.healthTimer) clearTimeout(this.healthTimer)
    this.healthTimer = setTimeout(() => void this.healthCheck(), jittered(HEALTH_CHECK_MS, 0.2))
  }

  /** Le lecteur répond-il encore ? Vérifié sans bloquer (port de contrôle de rclone, délai de 5 s). */
  private async healthCheck(): Promise<void> {
    try {
      if (this.state.phase !== 'connected') return
      const healthy = await this.mount.healthy()
      if (this.state.phase !== 'connected') return
      this.healthFailures = healthy ? 0 : this.healthFailures + 1
      if (this.healthFailures >= HEALTH_FAILURES) {
        this.healthFailures = 0
        this.live.stop()
        this.update({ phase: 'offline', mounted: false })
        this.scheduleRetry()
      }
    } catch (error) {
      console.warn('[Mapli Drive] santé du lecteur', error)
    } finally {
      this.scheduleHealth()
    }
  }

  private async reconnectIfNeeded(): Promise<void> {
    if (!this.device) return
    if (
      this.state.phase === 'offline' ||
      (this.state.phase === 'connected' && !(await this.mount.healthy()))
    ) {
      await this.connect()
    }
  }

  private scheduleRetry(error?: unknown): void {
    this.clearRetry()
    // Gigue pleine : après une panne, les postes ne reviennent pas tous à la même seconde.
    const delay = reconnectRetryDelay(error, this.retryCount)
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
        // quoi redessiner l'icône et son menu à chaque relevé).
        const unchanged =
          stats.pendingUploads === this.state.pendingUploads &&
          stats.transfers.length === 0 &&
          this.state.transfers.length === 0
        if (!unchanged) {
          this.update({ transfers: stats.transfers, pendingUploads: stats.pendingUploads })
        }
        if (uploadsSettled(previous, this.uploadSnapshot())) {
          this.live.uploadsSettled()
          if (this.windowVisible) void this.refreshRecent()
          // Un fichier vient d'arriver dans le dossier d'un salarié ? La fenêtre le propose.
          void this.refreshEmployeeSpace()
        }
        // rclone essuie des refus (401) : le poste a peut-être été révoqué.
        if (
          stats.errors > this.rcloneErrors &&
          /\b401\b|unauthori[sz]ed/i.test(stats.lastError ?? '')
        )
          void this.verifyToken()
        this.rcloneErrors = stats.errors
        this.scheduleStats()
      },
      statsDelay(this.windowVisible, this.uploadSnapshot(), this.live.isPushing)
    )
  }

  private uploadSnapshot(): UploadSnapshot {
    return {
      transfers: this.state.transfers.length,
      pendingUploads: this.state.pendingUploads,
      completed: this.completedTransfers
    }
  }

  /** Le token est-il toujours valable ? (401 : le poste est déconnecté.) */
  private async verifyToken(): Promise<void> {
    if (!this.device || Date.now() - this.tokenCheckedAt < TOKEN_CHECK_MS) return
    this.tokenCheckedAt = Date.now()
    try {
      await api.driveRevision(this.device.token)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) this.onRevoked()
    }
  }

  private async refreshRecent(): Promise<void> {
    if (!this.device || this.state.phase !== 'connected') return
    try {
      this.update({ recent: await api.recent(this.device.token) })
    } catch (error) {
      // Liste indicative : une erreur passagère ne change rien.
      if (error instanceof ApiError && error.status === 401) this.onRevoked()
    }
  }

  /** La phrase à montrer, en français ; le détail technique (souvent anglais) va à la console. */
  private message(error: unknown, context: ErrorContext): string {
    console.warn(`[Mapli Drive] ${context}`, error)
    return toUserMessage(error, context)
  }

  /** Seulement si quelque chose change : l'icône, son menu et les fenêtres ne sont pas redessinés pour rien. */
  private update(partial: Partial<DriveState>): void {
    if (changedKeys(this.state, partial).length === 0) return
    this.state = { ...this.state, ...partial }
    this.emit('state', this.state)
  }
}
