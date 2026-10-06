import type { EventEmitter } from 'events'
import type { FoldersResult } from './api-payloads'
import { between, httpStatus, jittered, pollRetryDelay, type Random } from './backoff'
import {
  compareRevision,
  emptyPlan,
  finalizePlan,
  FolderMap,
  forgetAllPlan,
  isEmptyPlan,
  mergePlans,
  parseDriveChanged,
  planForFolders,
  planForTreeChange,
  type InvalidationPlan,
  type RevisionStep
} from './invalidation'
import { systemClock, type Clock } from './clock'
import type { RealtimeAuth, RealtimeScope } from './realtime'

/*
 * Garder le lecteur à jour des changements faits ailleurs, sans Electron pour être testé.
 *
 *  - push (connexion temps réel établie) : le serveur annonce les changements ; seuls les
 *    dossiers touchés sont oubliés. Révision et état du coffre relus une fois par heure
 *    (filet de sécurité, et le token d'appareil, glissant sur 30 jours, reste en vie) ;
 *  - degraded (connexion tombée depuis plus d'une minute) : révision toutes les 3 min ;
 *  - legacy (serveur sans temps réel, version antérieure) : le rythme d'avant (révision
 *    toutes les 20 s, état toutes les 5 min), et un nouvel essai du temps réel par demi-heure ;
 *  - paused (veille, écran verrouillé) : rien ne part.
 *
 * Tous les rythmes sont tirés au hasard (±20 à 30 %) ; après un échec, l'attente grandit
 * et respecte le Retry-After du serveur ; hors ligne, on n'interroge pas.
 */

export type SyncMode = 'off' | 'connecting' | 'push' | 'degraded' | 'legacy' | 'paused'

export interface LiveSyncHost {
  /** GET /desktop/app/drive/revision. */
  fetchRevision(): Promise<string>
  /** GET /desktop/app/drive, appliqué par l'hôte ; rejette en cas d'erreur. */
  refreshStatus(): Promise<void>
  /** GET /desktop/app/drive/folders (avec If-None-Match). */
  fetchFolders(etag: string | null): Promise<FoldersResult>
  /** Fait oublier ces dossiers au lecteur et relire l'Explorateur. */
  invalidate(plan: InvalidationPlan): Promise<void>
  /** Des envois partent ou attendent (l'invalidation attend leur fin). */
  busy(): Promise<boolean>
  windowVisible(): boolean
  refreshRecent(): void
  refreshPending(): void
  /** Token révoqué : démontage et déconnexion du poste. */
  revoked(): void
  online(): boolean
}

/** Ce que LiveSync attend du client temps réel (RealtimeClient, ou un double de test). */
export interface RealtimeLike extends EventEmitter {
  readonly isConnected: boolean
  readonly isRunning: boolean
  start(): void
  stop(): void
  pause(): void
  resume(): void
}

export interface LiveSyncOptions {
  createRealtime(): RealtimeLike
  clock?: Clock
  random?: Random
  /** L'écran est-il verrouillé ? (filet si l'événement de déverrouillage manque). */
  isLocked?(): boolean
  log?(message: string): void
}

/** Connexion tombée depuis plus longtemps : interrogation de secours. */
export const DEGRADE_AFTER_MS = 60_000
export const PUSH_POLL_MS = 60 * 60_000
export const PUSH_POLL_RATIO = 0.2
export const DEGRADED_REVISION_MS = 180_000
export const DEGRADED_REVISION_RATIO = 0.3
export const LEGACY_REVISION_MS = 20_000
export const LEGACY_STATUS_MS = 5 * 60_000
export const LEGACY_RATIO = 0.2
/** Serveur sans temps réel : nouvel essai par demi-heure (il a pu être mis à jour). */
export const PROBE_MS = 30 * 60_000
/** Plafond de l'attente entre deux interrogations quand le serveur est sous pression. */
export const POLL_BACKOFF_CAP_MS = 30 * 60_000
/** Relecture de la table des dossiers après un changement d'arborescence : étalée sur 5 s. */
export const FOLDERS_SPREAD_MS = 5_000
/** Table des dossiers absente du serveur : nouvel essai plus tard. */
export const FOLDERS_RETRY_MS = 30 * 60_000
/** Événements groupés avant d'être appliqués. */
export const BATCH_MS = 250
/** Envois en cours : l'invalidation attend, au plus ce temps-là. */
export const MAX_DEFER_MS = 5 * 60_000
export const DEFER_CHECK_MS = 15_000
export const RECENT_THROTTLE_MS = 2_000
/** Fenêtre ouverte : l'état du coffre est relu s'il date de plus que cela. */
export const STATUS_FRESH_MS = 5 * 60_000
export const LOCK_WATCH_MS = 5 * 60_000

type TimerName =
  | 'revision'
  | 'status'
  | 'probe'
  | 'degrade'
  | 'folders'
  | 'batch'
  | 'defer'
  | 'recent'
  | 'lock'
  | 'accessStatus'

export class LiveSync {
  mode: SyncMode = 'off'

  private readonly clock: Clock
  private readonly random: Random
  private realtime: RealtimeLike | null = null
  private running = false
  private suspended = false
  private locked = false
  /** Le serveur n'a pas de temps réel (404) : rythme d'avant. */
  private legacy = false
  private lastRev: string | null = null
  private tokenId: number | null = null
  private readonly folders = new FolderMap()
  private foldersRetryAt = 0
  private foldersFetching = false
  private foldersAgain = false
  private readonly pendingTreeIds = new Set<string>()
  private batch: InvalidationPlan | null = null
  private deferred: InvalidationPlan | null = null
  private deferredSince = 0
  private flushing = false
  private revisionFailures = 0
  private statusFailures = 0
  private lastStatusAt = 0
  private lastRecentAt = 0
  private readonly timers: Record<TimerName, unknown> = {
    revision: null,
    status: null,
    probe: null,
    degrade: null,
    folders: null,
    batch: null,
    defer: null,
    recent: null,
    lock: null,
    accessStatus: null
  }

  constructor(
    private readonly host: LiveSyncHost,
    private readonly options: LiveSyncOptions
  ) {
    this.clock = options.clock ?? systemClock
    this.random = options.random ?? Math.random
  }

  /** Lecteur monté (nouveau montage : rien n'est encore en cache). */
  start(): void {
    if (this.running) return
    this.running = true
    this.legacy = false
    this.lastRev = null
    this.tokenId = null
    this.folders.clear()
    this.foldersRetryAt = 0
    this.pendingTreeIds.clear()
    this.batch = null
    this.deferred = null
    this.deferredSince = 0
    this.revisionFailures = 0
    this.statusFailures = 0
    // L'état du coffre vient d'être lu par le montage.
    this.lastStatusAt = this.clock.now()

    const realtime = this.options.createRealtime()
    this.realtime = realtime
    realtime.on('connected', (auth: RealtimeAuth) => this.onConnected(auth))
    realtime.on('disconnected', () => this.onDisconnected())
    realtime.on('unsupported', () => this.enterLegacy())
    realtime.on('unauthorized', () => this.host.revoked())
    realtime.on('blocked', () => this.onBlocked())
    realtime.on('event', (scope: RealtimeScope, name: string, data: unknown) =>
      this.onEvent(scope, name, data)
    )

    if (this.paused) {
      this.mode = 'paused'
      return
    }
    this.enterConnecting(true)
  }

  /** Lecteur démonté (pause, coupure, déconnexion du poste). */
  stop(): void {
    if (!this.running) return
    this.running = false
    this.realtime?.removeAllListeners()
    this.realtime?.stop()
    this.realtime = null
    for (const name of Object.keys(this.timers) as TimerName[]) this.clear(name)
    this.batch = null
    this.deferred = null
    this.mode = 'off'
  }

  get isPushing(): boolean {
    return this.mode === 'push'
  }

  setSuspended(suspended: boolean): void {
    this.suspended = suspended
    this.updatePause()
  }

  setLocked(locked: boolean): void {
    this.locked = locked
    this.updatePause()
  }

  /** La fenêtre vient de s'ouvrir : fichiers récents, et l'état du coffre s'il date. */
  windowShown(): void {
    if (!this.running) return
    this.lastRecentAt = this.clock.now()
    this.host.refreshRecent()
    if (this.clock.now() - this.lastStatusAt > STATUS_FRESH_MS) void this.pollStatus(false)
  }

  /** Les envois viennent de se terminer : l'invalidation qui attendait passe. */
  uploadsSettled(): void {
    if (!this.running || !this.deferred) return
    this.clear('defer')
    void this.flush()
  }

  // ── Modes ───────────────────────────────────────────────

  private get paused(): boolean {
    return this.suspended || this.locked
  }

  private get active(): boolean {
    return this.running && this.mode !== 'paused' && this.mode !== 'off'
  }

  private enterConnecting(fresh: boolean): void {
    this.mode = 'connecting'
    const realtime = this.realtime
    if (realtime) {
      if (!realtime.isRunning) realtime.start()
      else if (!fresh) realtime.resume()
    }
    this.armDegrade()
    this.scheduleStatus(jittered(PUSH_POLL_MS, PUSH_POLL_RATIO, this.random))
  }

  private armDegrade(): void {
    this.clear('degrade')
    this.timers.degrade = this.clock.setTimeout(() => {
      this.timers.degrade = null
      this.enterDegraded()
    }, DEGRADE_AFTER_MS)
  }

  private enterDegraded(): void {
    if (!this.active || this.mode === 'push' || this.mode === 'legacy') return
    this.mode = 'degraded'
    this.log('connexion temps réel indisponible : interrogation de secours')
    // Des changements ont pu échapper au poste pendant la coupure : un premier relevé tout de suite.
    this.scheduleRevision(between(0, 5_000, this.random))
    if (!this.timers.status)
      this.scheduleStatus(jittered(PUSH_POLL_MS, PUSH_POLL_RATIO, this.random))
  }

  private enterLegacy(): void {
    if (!this.running) return
    const already = this.legacy && this.mode === 'legacy'
    this.legacy = true
    this.clear('degrade')
    this.scheduleProbe()
    if (this.paused || already) return
    this.mode = 'legacy'
    this.log('serveur sans temps réel : interrogation régulière')
    this.scheduleRevision(between(0, 2_000, this.random))
    this.scheduleStatus(jittered(LEGACY_STATUS_MS, LEGACY_RATIO, this.random))
  }

  private onConnected(auth: RealtimeAuth): void {
    if (!this.running) return
    this.legacy = false
    this.clear('degrade')
    this.clear('probe')
    this.mode = 'push'
    this.tokenId = auth.tokenId
    this.revisionFailures = 0
    // La signature vaut relevé de révision : le prochain, dans une heure.
    this.scheduleRevision(jittered(PUSH_POLL_MS, PUSH_POLL_RATIO, this.random))
    if (!this.timers.status)
      this.scheduleStatus(jittered(PUSH_POLL_MS, PUSH_POLL_RATIO, this.random))
    const step = this.catchUp(auth.rev)
    // Table des dossiers (ETag : le plus souvent une réponse 304 vide), étalée sur quelques secondes.
    this.scheduleFolders(between(0, FOLDERS_SPREAD_MS, this.random))
    // Reconnexion sans changement du coffre : une publication a pu attendre pendant la coupure.
    // (Premier relevé après le montage : le montage vient de la demander.)
    if (step === 'same') {
      this.host.refreshPending()
      this.recentSoon()
    }
  }

  private onDisconnected(): void {
    if (!this.running || this.paused) return
    if (this.mode === 'push') this.mode = 'connecting'
    this.armDegrade()
  }

  private onBlocked(): void {
    // WebSockets bloqués (proxy, pare-feu) : inutile d'attendre la minute réglementaire.
    if (this.mode === 'connecting') {
      this.clear('degrade')
      this.enterDegraded()
    }
  }

  private updatePause(): void {
    if (!this.running) return
    if (this.paused && this.mode !== 'paused') {
      this.mode = 'paused'
      this.realtime?.pause()
      for (const name of ['revision', 'status', 'probe', 'degrade', 'accessStatus'] as const)
        this.clear(name)
      if (this.locked) this.armLockWatch()
      return
    }
    if (!this.paused && this.mode === 'paused') {
      this.clear('lock')
      if (this.legacy) {
        this.mode = 'legacy'
        this.scheduleRevision(between(1_000, 10_000, this.random))
        this.scheduleStatus(jittered(LEGACY_STATUS_MS, LEGACY_RATIO, this.random))
        this.scheduleProbe()
      } else {
        this.enterConnecting(false)
      }
    } else if (!this.locked) {
      this.clear('lock')
    }
  }

  /** Déverrouillage parfois non signalé (changement rapide d'utilisateur…) : on vérifie de temps en temps. */
  private armLockWatch(): void {
    this.clear('lock')
    if (!this.options.isLocked) return
    this.timers.lock = this.clock.setTimeout(() => {
      this.timers.lock = null
      if (this.locked && this.options.isLocked && !this.options.isLocked()) this.setLocked(false)
      else if (this.locked) this.armLockWatch()
    }, LOCK_WATCH_MS)
  }

  // ── Interrogations ──────────────────────────────────────

  private revisionCadence(): [number, number] {
    if (this.mode === 'degraded') return [DEGRADED_REVISION_MS, DEGRADED_REVISION_RATIO]
    if (this.mode === 'legacy') return [LEGACY_REVISION_MS, LEGACY_RATIO]
    return [PUSH_POLL_MS, PUSH_POLL_RATIO]
  }

  private statusCadence(): [number, number] {
    return this.mode === 'legacy'
      ? [LEGACY_STATUS_MS, LEGACY_RATIO]
      : [PUSH_POLL_MS, PUSH_POLL_RATIO]
  }

  private scheduleRevision(delay: number): void {
    this.clear('revision')
    this.timers.revision = this.clock.setTimeout(() => {
      this.timers.revision = null
      void this.pollRevision()
    }, delay)
  }

  private scheduleStatus(delay: number): void {
    this.clear('status')
    this.timers.status = this.clock.setTimeout(() => {
      this.timers.status = null
      void this.pollStatus(true)
    }, delay)
  }

  private scheduleProbe(): void {
    this.clear('probe')
    this.timers.probe = this.clock.setTimeout(
      () => {
        this.timers.probe = null
        if (!this.running || this.paused || !this.legacy) return
        if (this.realtime && !this.realtime.isRunning) this.realtime.start()
        this.scheduleProbe()
      },
      jittered(PROBE_MS, LEGACY_RATIO, this.random)
    )
  }

  private async pollRevision(): Promise<void> {
    if (!this.active) return
    const [interval, ratio] = this.revisionCadence()
    if (!this.host.online()) {
      this.scheduleRevision(jittered(interval, ratio, this.random))
      return
    }
    try {
      const rev = await this.host.fetchRevision()
      if (!this.active) return
      this.revisionFailures = 0
      this.catchUp(rev)
      const [next, nextRatio] = this.revisionCadence()
      this.scheduleRevision(jittered(next, nextRatio, this.random))
    } catch (error) {
      if (!this.active) return
      if (httpStatus(error) === 401) {
        this.host.revoked()
        return
      }
      this.revisionFailures += 1
      const [next, nextRatio] = this.revisionCadence()
      this.scheduleRevision(
        pollRetryDelay(
          error,
          this.revisionFailures,
          next,
          nextRatio,
          POLL_BACKOFF_CAP_MS,
          this.random
        )
      )
    }
  }

  /** `scheduled` : relevé programmé (sinon ponctuel : fenêtre ouverte, accès changés). */
  private async pollStatus(scheduled: boolean): Promise<void> {
    if (!this.active) return
    const [interval, ratio] = this.statusCadence()
    if (!this.host.online()) {
      if (scheduled) this.scheduleStatus(jittered(interval, ratio, this.random))
      return
    }
    try {
      await this.host.refreshStatus()
      if (!this.active) return
      this.lastStatusAt = this.clock.now()
      this.statusFailures = 0
      if (scheduled) this.scheduleStatus(jittered(interval, ratio, this.random))
    } catch (error) {
      if (!this.active) return
      if (httpStatus(error) === 401) {
        this.host.revoked()
        return
      }
      this.statusFailures += 1
      if (scheduled)
        this.scheduleStatus(
          pollRetryDelay(
            error,
            this.statusFailures,
            interval,
            ratio,
            POLL_BACKOFF_CAP_MS,
            this.random
          )
        )
    }
  }

  /**
   * Révision lue (relevé, connexion) : différente de la dernière vue, des changements ont
   * échappé au poste — tout est oublié. La première après un montage fait relire
   * l'arborescence à l'Explorateur.
   */
  private catchUp(rev: string | null): RevisionStep {
    const step = compareRevision(this.lastRev, rev)
    if (rev !== null) this.lastRev = rev
    if (step === 'same') return step
    this.queue(forgetAllPlan())
    if (step === 'first') return step
    // Dépôt dans le dossier d'un salarié, validation faite ailleurs…
    this.host.refreshPending()
    this.recentSoon()
    return step
  }

  // ── Événements ──────────────────────────────────────────

  private onEvent(scope: RealtimeScope, name: string, data: unknown): void {
    if (!this.running) return
    if (scope === 'org' && name === 'drive.changed') {
      this.onDriveChanged(data)
      return
    }
    if (scope !== 'member') return
    if (name === 'space.changed') this.host.refreshPending()
    else if (name === 'access.changed') this.onAccessChanged()
    else if (name === 'device.revoked') this.onDeviceRevoked(data)
  }

  private onDriveChanged(data: unknown): void {
    const change = parseDriveChanged(data)
    if (!change) return
    const step = compareRevision(this.lastRev, change.rev)
    if (change.rev !== null) this.lastRev = change.rev
    this.recentSoon()

    // Révision sautée (un événement a échappé au poste) ou changement global : tout oublier.
    if (step === 'skipped' || change.folders === 'all') {
      this.queue(forgetAllPlan())
      if (change.tree) this.scheduleFolders(between(0, FOLDERS_SPREAD_MS, this.random))
      return
    }
    if (this.foldersUnavailable()) {
      this.queue(forgetAllPlan())
      return
    }

    const plan = emptyPlan()
    plan.trash = change.trash
    if (this.folders.loaded) {
      const { plan: known, unknown } = planForFolders(this.folders, change.folders)
      this.queue(mergePlans(plan, known))
      // Dossier inconnu : nouveau (connu après relecture de la table), ou que la personne ne voit pas.
      if (change.tree) unknown.forEach((id) => this.pendingTreeIds.add(id))
    } else {
      // Table pas encore lue : les dossiers seront résolus dès qu'elle arrive.
      this.queue(plan)
      change.folders.forEach((id) => this.pendingTreeIds.add(id))
      this.scheduleFolders(0)
      return
    }
    if (change.tree) this.scheduleFolders(between(0, FOLDERS_SPREAD_MS, this.random))
  }

  private onAccessChanged(): void {
    this.queue(forgetAllPlan())
    this.scheduleFolders(between(0, FOLDERS_SPREAD_MS, this.random))
    this.clear('accessStatus')
    this.timers.accessStatus = this.clock.setTimeout(
      () => {
        this.timers.accessStatus = null
        void this.pollStatus(false)
      },
      between(0, FOLDERS_SPREAD_MS, this.random)
    )
    this.recentSoon()
  }

  private onDeviceRevoked(data: unknown): void {
    const value =
      data && typeof data === 'object' ? (data as Record<string, unknown>).token_id : undefined
    const id = typeof value === 'number' ? value : Number(value)
    if (this.tokenId !== null) {
      // Un autre appareil de la même personne : rien à faire ici.
      if (Number.isFinite(id) && id === this.tokenId) this.host.revoked()
      return
    }
    // Identifiant du token inconnu : le serveur tranche (401 si c'est ce poste).
    this.host.fetchRevision().catch((error: unknown) => {
      if (httpStatus(error) === 401) this.host.revoked()
    })
  }

  // ── Table des dossiers ──────────────────────────────────

  private foldersUnavailable(): boolean {
    return this.foldersRetryAt > this.clock.now()
  }

  private scheduleFolders(delay: number): void {
    if (this.foldersFetching) {
      this.foldersAgain = true
      return
    }
    if (this.timers.folders) return
    this.timers.folders = this.clock.setTimeout(() => {
      this.timers.folders = null
      void this.refreshFolders()
    }, delay)
  }

  private async refreshFolders(): Promise<void> {
    if (!this.running) return
    const ids = [...this.pendingTreeIds]
    this.pendingTreeIds.clear()
    if (this.foldersUnavailable()) {
      if (ids.length > 0) this.queue(forgetAllPlan())
      return
    }
    this.foldersFetching = true
    try {
      const result = await this.host.fetchFolders(this.folders.etag)
      if (!this.running) return
      if (result.notModified) {
        this.queue(planForFolders(this.folders, ids).plan)
      } else {
        const diff = this.folders.replace(result.folders, result.etag)
        this.queue(planForTreeChange(diff, this.folders, ids))
      }
    } catch (error) {
      if (!this.running) return
      const status = httpStatus(error)
      if (status === 401) {
        this.host.revoked()
        return
      }
      if (status === 404) this.foldersRetryAt = this.clock.now() + FOLDERS_RETRY_MS
      // Sans la table, les dossiers annoncés ne peuvent pas être situés : tout oublier.
      if (ids.length > 0) this.queue(forgetAllPlan())
    } finally {
      this.foldersFetching = false
      if (this.running && (this.foldersAgain || this.pendingTreeIds.size > 0)) {
        this.foldersAgain = false
        this.scheduleFolders(between(1_000, FOLDERS_SPREAD_MS, this.random))
      }
    }
  }

  // ── Application ─────────────────────────────────────────

  private queue(plan: InvalidationPlan): void {
    if (!this.running || isEmptyPlan(plan)) return
    this.batch = this.batch ? mergePlans(this.batch, plan) : plan
    if (!this.timers.batch) {
      this.timers.batch = this.clock.setTimeout(() => {
        this.timers.batch = null
        void this.flush()
      }, BATCH_MS)
    }
  }

  private async flush(): Promise<void> {
    if (!this.running) return
    if (this.flushing) {
      // Une application est en cours : la suite passera juste après.
      if (!this.timers.batch && (this.batch || this.deferred)) {
        this.timers.batch = this.clock.setTimeout(() => {
          this.timers.batch = null
          void this.flush()
        }, BATCH_MS)
      }
      return
    }
    const parts = [this.deferred, this.batch].filter((p): p is InvalidationPlan => p !== null)
    this.deferred = null
    this.batch = null
    if (parts.length === 0) return
    const plan = parts.reduce(mergePlans)

    this.flushing = true
    try {
      // Des envois partent : on attend qu'ils soient finis (5 min au plus).
      if (await this.host.busy()) {
        const now = this.clock.now()
        if (this.deferredSince === 0) this.deferredSince = now
        if (now - this.deferredSince < MAX_DEFER_MS && this.running) {
          this.deferred = this.deferred ? mergePlans(plan, this.deferred) : plan
          this.clear('defer')
          this.timers.defer = this.clock.setTimeout(() => {
            this.timers.defer = null
            void this.flush()
          }, DEFER_CHECK_MS)
          return
        }
      }
      this.deferredSince = 0
      if (this.running) await this.host.invalidate(finalizePlan(plan))
    } catch (error) {
      // Le lecteur se rafraîchira de lui-même (cache des dossiers limité à 10 min).
      this.log(
        `invalidation impossible : ${error instanceof Error ? error.message : String(error)}`
      )
    } finally {
      this.flushing = false
    }
  }

  /** Fichiers récents : seulement fenêtre ouverte, une fois toutes les 2 s au plus. */
  private recentSoon(): void {
    if (!this.host.windowVisible() || this.timers.recent) return
    const wait = Math.max(0, this.lastRecentAt + RECENT_THROTTLE_MS - this.clock.now())
    this.timers.recent = this.clock.setTimeout(() => {
      this.timers.recent = null
      if (!this.running || !this.host.windowVisible()) return
      this.lastRecentAt = this.clock.now()
      this.host.refreshRecent()
    }, wait)
  }

  private clear(name: TimerName): void {
    if (this.timers[name] !== null) this.clock.clearTimeout(this.timers[name])
    this.timers[name] = null
  }

  private log(message: string): void {
    this.options.log?.(`[synchro] ${message}`)
  }
}
