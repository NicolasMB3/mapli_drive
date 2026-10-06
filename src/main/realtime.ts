import { EventEmitter } from 'events'
import {
  between,
  classifyClose,
  httpStatus,
  realtimeRetryDelay,
  retryAfterOf,
  type CloseKind,
  type Random
} from './backoff'
import { systemClock, type Clock } from './clock'

/*
 * Client temps réel (protocole Pusher 7, serveur Laravel Reverb), sans Electron pour être
 * testé : le serveur prévient le poste dès qu'un dossier change, au lieu que le poste
 * l'interroge sans cesse.
 *
 *   connexion → pusher:connection_established (socket_id) → signatures des canaux
 *   (POST /desktop/app/realtime/auth) → pusher:subscribe des deux canaux privés
 *   (organisation, membre) → événements.
 *
 * Silence prolongé : pusher:ping, et la connexion est abandonnée sans réponse sous 15 s.
 * Reprises prudentes (voir backoff.ts) ; sur un réseau qui bloque les WebSockets, le
 * client se fait discret et le poste reste en interrogation de secours.
 */

export interface RealtimeEndpoint {
  key: string
  host: string
  port: number
  scheme: 'https' | 'http'
}

export interface RealtimeAuth extends RealtimeEndpoint {
  channels: { org: string; member: string }
  /** Signature (« clé:signature ») par canal. */
  auth: Record<string, string>
  /** Révision du coffre au moment de la signature (rattrapage après une coupure). */
  rev: string | null
  /** Identifiant du token de ce poste (événement device.revoked). */
  tokenId: number | null
}

export interface RealtimeSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  /** Abandon immédiat, sans échange de fermeture (connexion morte). */
  terminate(): void
}

export interface SocketHandlers {
  onMessage(data: string): void
  onClose(code: number): void
  onError(error: Error): void
}

export type SocketOpener = (url: string, handlers: SocketHandlers) => Promise<RealtimeSocket>

export interface RealtimeDeps {
  /** Version de l'application, annoncée dans l'adresse (?version=). */
  version: string
  /** Signatures des canaux pour ce socket_id (POST /desktop/app/realtime/auth). */
  authorize(socketId: string): Promise<RealtimeAuth>
  open: SocketOpener
  /** Point d'accès (clé Reverb, hôte) gardé d'une session à l'autre. */
  loadEndpoint(): RealtimeEndpoint | null
  saveEndpoint(endpoint: RealtimeEndpoint): void
  clearEndpoint(): void
  /** ws:// accepté (développement contre un serveur local) ; sinon wss:// seulement. */
  allowInsecure?: boolean
  online?(): boolean
  random?: Random
  clock?: Clock
  log?(message: string): void
}

export type RealtimeState = 'idle' | 'connecting' | 'connected' | 'waiting' | 'paused'
export type RealtimeScope = 'org' | 'member'

/** Premier lancement : la clé Reverb vient de la réponse de signature, demandée une fois. */
export const BOOTSTRAP_SOCKET_ID = '1.1'
/** Délai pour recevoir pusher:connection_established. */
export const HANDSHAKE_TIMEOUT_MS = 30_000
/** Délai pour signer et s'abonner aux deux canaux. */
export const SUBSCRIBE_TIMEOUT_MS = 20_000
export const PONG_TIMEOUT_MS = 15_000
/** Connexion jugée stable : les échecs passés sont oubliés. */
export const STABLE_AFTER_MS = 5 * 60_000
/** Échecs d'ouverture consécutifs (réseau en ligne) avant de conclure au blocage. */
export const BLOCKED_AFTER_FAILURES = 8
const DEFAULT_ACTIVITY_TIMEOUT_S = 120

type TimerName = 'retry' | 'handshake' | 'subscribe' | 'activity' | 'pong' | 'stable'

interface PusherMessage {
  event: string
  channel?: string
  data?: unknown
}

/** Message reçu ; `data` arrive souvent encodé une seconde fois en JSON. */
export function parseMessage(raw: string): PusherMessage | null {
  let message: unknown
  try {
    message = JSON.parse(raw)
  } catch {
    return null
  }
  if (!message || typeof message !== 'object') return null
  const { event, channel, data } = message as Record<string, unknown>
  if (typeof event !== 'string') return null
  let payload = data
  if (typeof data === 'string') {
    try {
      payload = JSON.parse(data)
    } catch {
      payload = data
    }
  }
  return { event, channel: typeof channel === 'string' ? channel : undefined, data: payload }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** Point d'accès lisible et sûr (sinon null) : clé et hôte sans caractère d'adresse. */
export function endpointFrom(value: unknown): RealtimeEndpoint | null {
  const v = record(value)
  const key = typeof v.key === 'string' ? v.key : ''
  const host = typeof v.host === 'string' ? v.host.trim() : ''
  const port = typeof v.port === 'number' ? v.port : Number(v.port)
  const scheme = v.scheme === 'http' ? 'http' : v.scheme === 'https' ? 'https' : null
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(key)) return null
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) return null
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !scheme) return null
  return { key, host, port, scheme }
}

export function sameEndpoint(a: RealtimeEndpoint | null, b: RealtimeEndpoint | null): boolean {
  return (
    !!a && !!b && a.key === b.key && a.host === b.host && a.port === b.port && a.scheme === b.scheme
  )
}

export function realtimeUrl(endpoint: RealtimeEndpoint, version: string): string {
  const secure = endpoint.scheme === 'https'
  const port = endpoint.port === (secure ? 443 : 80) ? '' : `:${endpoint.port}`
  const query = `protocol=7&client=mapli-drive&version=${encodeURIComponent(version)}`
  return `${secure ? 'wss' : 'ws'}://${endpoint.host}${port}/app/${endpoint.key}?${query}`
}

interface FailOptions {
  /** Échec avant pusher:connection_established (compte pour la détection d'un blocage). */
  opening?: boolean
  /** Connexion à abandonner sans échange de fermeture. */
  terminate?: boolean
  /** Attente minimale (Retry-After du serveur). */
  atLeast?: number
}

export class RealtimeClient extends EventEmitter {
  state: RealtimeState = 'idle'
  /** Dernière attente programmée avant un nouvel essai (journal, tests). */
  lastRetryDelay: number | null = null

  private readonly clock: Clock
  private readonly random: Random
  private running = false
  private paused = false
  /** Chaque essai a son numéro : les rappels d'un essai abandonné sont ignorés. */
  private generation = 0
  private socket: RealtimeSocket | null = null
  private endpoint: RealtimeEndpoint | null = null
  private endpointFromCache = false
  private auth: RealtimeAuth | null = null
  private established = false
  private connected = false
  private readonly subscribed = new Set<string>()
  private buffered: { scope: RealtimeScope; name: string; data: unknown }[] = []
  private pusherErrorCode: number | null = null
  private attempt = 0
  private openFailures = 0
  private activityTimeoutMs = DEFAULT_ACTIVITY_TIMEOUT_S * 1000
  private readonly timers: Record<TimerName, unknown> = {
    retry: null,
    handshake: null,
    subscribe: null,
    activity: null,
    pong: null,
    stable: null
  }

  constructor(private readonly deps: RealtimeDeps) {
    super()
    this.clock = deps.clock ?? systemClock
    this.random = deps.random ?? Math.random
  }

  get isConnected(): boolean {
    return this.connected
  }

  get isRunning(): boolean {
    return this.running
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.paused = false
    this.attempt = 0
    this.openFailures = 0
    void this.connect()
  }

  stop(): void {
    this.running = false
    this.paused = false
    this.teardown()
    this.clear('retry')
    this.state = 'idle'
  }

  /** Mise en veille, écran verrouillé : la connexion est fermée. */
  pause(): void {
    if (!this.running || this.paused) return
    this.paused = true
    this.teardown()
    this.clear('retry')
    this.state = 'paused'
  }

  /** Sortie de veille, déverrouillage : reconnexion après 1 à 10 s (pas tous les postes ensemble). */
  resume(): void {
    if (!this.running || !this.paused) return
    this.paused = false
    // Le réseau a pu changer (poste emporté, VPN) : les échecs d'avant ne comptent plus.
    this.openFailures = 0
    this.schedule(between(1_000, 10_000, this.random))
  }

  // ── Connexion ───────────────────────────────────────────

  private async connect(): Promise<void> {
    this.clear('retry')
    if (!this.running || this.paused) return
    if (this.deps.online && !this.deps.online()) {
      // Hors ligne : on regarde de nouveau un peu plus tard, sans compter d'échec.
      this.schedule(between(5_000, 15_000, this.random))
      return
    }

    const generation = ++this.generation
    this.state = 'connecting'
    this.pusherErrorCode = null

    let endpoint = this.deps.loadEndpoint()
    if (endpoint && !this.allowed(endpoint)) endpoint = null
    this.endpointFromCache = endpoint !== null
    if (!endpoint) {
      try {
        endpoint = this.allowedOrNull(await this.deps.authorize(BOOTSTRAP_SOCKET_ID))
      } catch (error) {
        if (generation === this.generation) this.onAuthError(error)
        return
      }
      if (generation !== this.generation) return
      if (!endpoint) {
        this.log('point d’accès temps réel illisible')
        this.fail('slow', { opening: false })
        return
      }
      this.deps.saveEndpoint(endpoint)
    }
    this.endpoint = endpoint

    this.timers.handshake = this.clock.setTimeout(() => {
      if (generation === this.generation) this.fail('restart', { opening: true, terminate: true })
    }, HANDSHAKE_TIMEOUT_MS)

    try {
      const socket = await this.deps.open(realtimeUrl(endpoint, this.deps.version), {
        onMessage: (data) => {
          if (generation === this.generation) this.onMessage(generation, data)
        },
        onClose: (code) => {
          if (generation === this.generation) this.onClose(code)
        },
        onError: (error) => {
          if (generation === this.generation) this.log(`connexion : ${error.message}`)
        }
      })
      if (generation !== this.generation) {
        socket.close(1000)
        return
      }
      this.socket = socket
    } catch (error) {
      if (generation !== this.generation) return
      this.log(`ouverture impossible : ${error instanceof Error ? error.message : String(error)}`)
      this.onClose(1006)
    }
  }

  private onMessage(generation: number, raw: string): void {
    this.touch(generation)
    const message = parseMessage(raw)
    if (!message) return

    switch (message.event) {
      case 'pusher:connection_established':
        void this.onEstablished(generation, record(message.data))
        return
      case 'pusher:error':
        this.onPusherError(record(message.data))
        return
      case 'pusher:ping':
        this.send({ event: 'pusher:pong', data: {} })
        return
      case 'pusher:pong':
        return
      case 'pusher_internal:subscription_succeeded':
        if (message.channel) this.onSubscribed(message.channel)
        return
      case 'pusher:subscription_error':
      case 'pusher_internal:subscription_error':
        this.log(`abonnement refusé (${message.channel ?? '?'})`)
        this.fail('fatal')
        return
    }

    // Événements du serveur seulement : ni ceux du protocole, ni ceux d'autres clients.
    if (message.event.startsWith('pusher') || message.event.startsWith('client-')) return
    const scope = this.scopeOf(message.channel)
    if (!scope || !message.channel || !this.subscribed.has(message.channel)) return
    if (!this.connected) {
      // Un canal abonné avant l'autre : ses événements attendent la fin de la connexion.
      this.buffered.push({ scope, name: message.event, data: message.data })
      return
    }
    this.notify('event', scope, message.event, message.data)
  }

  private async onEstablished(generation: number, data: Record<string, unknown>): Promise<void> {
    const socketId = typeof data.socket_id === 'string' ? data.socket_id : null
    if (!socketId || this.established) {
      if (!socketId) this.fail('other')
      return
    }
    const activity = Number(data.activity_timeout)
    this.activityTimeoutMs =
      (Number.isFinite(activity) && activity > 0
        ? Math.min(Math.max(activity, 10), 600)
        : DEFAULT_ACTIVITY_TIMEOUT_S) * 1000
    this.established = true
    this.openFailures = 0
    this.clear('handshake')
    this.touch(generation)
    this.timers.subscribe = this.clock.setTimeout(() => {
      if (generation === this.generation) this.fail('other')
    }, SUBSCRIBE_TIMEOUT_MS)

    let auth: RealtimeAuth
    try {
      auth = await this.deps.authorize(socketId)
    } catch (error) {
      if (generation === this.generation) this.onAuthError(error)
      return
    }
    if (generation !== this.generation) return

    // La clé ou l'hôte ont changé côté serveur : on se reconnecte avec les nouveaux.
    const fresh = this.allowedOrNull(auth)
    if (fresh && !sameEndpoint(fresh, this.endpoint)) {
      this.deps.saveEndpoint(fresh)
      this.teardown()
      this.schedule(between(0, 2_000, this.random))
      return
    }

    const channels = [auth.channels?.org, auth.channels?.member]
    if (!channels.every((c) => typeof c === 'string' && c.startsWith('private-'))) {
      this.log('canaux temps réel absents de la réponse')
      this.fail('slow')
      return
    }
    this.auth = auth
    for (const channel of channels as string[]) {
      const signature = auth.auth?.[channel]
      if (typeof signature !== 'string' || !signature) {
        this.log(`signature absente pour ${channel}`)
        this.fail('slow')
        return
      }
      this.send({ event: 'pusher:subscribe', data: { channel, auth: signature } })
    }
  }

  private onSubscribed(channel: string): void {
    if (!this.auth || !this.scopeOf(channel)) return
    this.subscribed.add(channel)
    if (this.connected || this.subscribed.size < 2) return

    this.connected = true
    this.state = 'connected'
    this.clear('subscribe')
    const generation = this.generation
    this.timers.stable = this.clock.setTimeout(() => {
      if (generation === this.generation) this.attempt = 0
    }, STABLE_AFTER_MS)
    this.notify('connected', this.auth)
    const buffered = this.buffered
    this.buffered = []
    for (const e of buffered) this.notify('event', e.scope, e.name, e.data)
  }

  private onPusherError(data: Record<string, unknown>): void {
    const code = typeof data.code === 'number' ? data.code : Number(data.code)
    this.log(`pusher:error ${Number.isFinite(code) ? code : '?'} ${String(data.message ?? '')}`)
    if (!Number.isFinite(code)) return
    this.pusherErrorCode = code
    if (code < 4000 || code > 4299) return
    // Application inconnue avec une clé gardée d'une session précédente : on la redemande.
    if ((code === 4001 || code === 4003) && this.endpointFromCache) {
      this.deps.clearEndpoint()
      this.fail('other')
      return
    }
    this.fail(classifyClose(code))
  }

  private onAuthError(error: unknown): void {
    const status = httpStatus(error)
    if (status === 404) {
      // Serveur sans temps réel (version antérieure) : le poste reste en interrogation.
      this.halt()
      this.notify('unsupported')
      return
    }
    if (status === 401) {
      this.halt()
      this.notify('unauthorized')
      return
    }
    if (status === 403) {
      this.fail('slow', { opening: false })
      return
    }
    this.fail(status === 429 || status === 503 ? 'capacity' : 'other', {
      opening: false,
      atLeast: retryAfterOf(error) ?? 0
    })
  }

  private onClose(code: number): void {
    const opening = !this.established
    const kind = classifyClose(this.pusherErrorCode ?? code)
    this.socket = null
    this.fail(kind, { opening })
  }

  /** Abandon de l'essai en cours, puis le suivant, programmé selon la cause. */
  private fail(kind: CloseKind | 'slow', options: FailOptions = {}): void {
    const wasConnected = this.connected
    const opening = options.opening ?? !this.established
    this.teardown(options.terminate)
    if (!this.running || this.paused) return

    if (wasConnected) this.notify('disconnected')
    if (opening && (!this.deps.online || this.deps.online())) this.openFailures += 1

    let delay: number
    if (this.openFailures >= BLOCKED_AFTER_FAILURES) {
      // Les WebSockets ne passent pas (proxy, pare-feu) : nouvel essai de loin en loin.
      if (this.openFailures === BLOCKED_AFTER_FAILURES) this.notify('blocked')
      delay = realtimeRetryDelay('slow', this.attempt, false, this.random)
    } else {
      delay = realtimeRetryDelay(kind, this.attempt, wasConnected, this.random)
    }
    this.attempt += 1
    this.schedule(Math.max(delay, options.atLeast ?? 0))
  }

  /** Arrêt sans nouvel essai (serveur sans temps réel, poste révoqué). */
  private halt(): void {
    this.running = false
    this.teardown()
    this.clear('retry')
    this.state = 'idle'
  }

  private schedule(delay: number): void {
    this.clear('retry')
    this.state = 'waiting'
    this.lastRetryDelay = delay
    this.timers.retry = this.clock.setTimeout(() => void this.connect(), delay)
  }

  /** Ferme la connexion de l'essai en cours (ses rappels seront ignorés) et ses minuteries. */
  private teardown(terminate = false): void {
    this.generation += 1
    for (const name of ['handshake', 'subscribe', 'activity', 'pong', 'stable'] as const)
      this.clear(name)
    const socket = this.socket
    this.socket = null
    this.connected = false
    this.established = false
    this.auth = null
    this.subscribed.clear()
    this.buffered = []
    if (this.state !== 'paused') this.state = 'idle'
    if (!socket) return
    try {
      if (terminate) socket.terminate()
      else socket.close(1000)
    } catch {
      // déjà fermée
    }
  }

  // ── Activité ────────────────────────────────────────────

  /** Un message est arrivé : la connexion vit. Au bout du délai d'inactivité, pusher:ping. */
  private touch(generation: number): void {
    this.clear('pong')
    this.clear('activity')
    this.timers.activity = this.clock.setTimeout(() => {
      if (generation !== this.generation) return
      this.send({ event: 'pusher:ping', data: {} })
      this.timers.pong = this.clock.setTimeout(() => {
        if (generation !== this.generation) return
        this.log('pas de pusher:pong : connexion abandonnée')
        this.fail('restart', { terminate: true })
      }, PONG_TIMEOUT_MS)
    }, this.activityTimeoutMs)
  }

  // ── Outils ──────────────────────────────────────────────

  private send(message: { event: string; data: unknown }): void {
    try {
      this.socket?.send(JSON.stringify(message))
    } catch (error) {
      this.log(`envoi impossible : ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private scopeOf(channel: string | undefined): RealtimeScope | null {
    if (!channel || !this.auth) return null
    if (channel === this.auth.channels.org) return 'org'
    if (channel === this.auth.channels.member) return 'member'
    return null
  }

  private allowed(endpoint: RealtimeEndpoint): boolean {
    return endpoint.scheme === 'https' || this.deps.allowInsecure === true
  }

  private allowedOrNull(value: unknown): RealtimeEndpoint | null {
    const endpoint = endpointFrom(value)
    return endpoint && this.allowed(endpoint) ? endpoint : null
  }

  private clear(name: TimerName): void {
    if (this.timers[name] !== null) this.clock.clearTimeout(this.timers[name])
    this.timers[name] = null
  }

  /** Prévient les abonnés ; une erreur chez l'un d'eux ne remonte jamais jusqu'à la connexion. */
  private notify(event: string, ...args: unknown[]): void {
    try {
      this.emit(event, ...args)
    } catch (error) {
      this.log(`${event} : ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private log(message: string): void {
    this.deps.log?.(`[temps réel] ${message}`)
  }
}
