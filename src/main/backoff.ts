/*
 * Rythmes et reprises, à part (sans Electron) pour être testés. Tous les intervalles sont
 * tirés au hasard autour de leur valeur (± quelques dizaines de %) : des milliers de
 * postes démarrés à la même heure ne frappent jamais le serveur en même temps. Après une
 * erreur, l'attente double (gigue « pleine ») et respecte le Retry-After du serveur.
 */

export type Random = () => number

/** Valeur tirée uniformément dans [min, max]. */
export function between(minMs: number, maxMs: number, random: Random = Math.random): number {
  return Math.round(minMs + (maxMs - minMs) * random())
}

/** Intervalle à ±`ratio` près (0,2 : entre 80 % et 120 % de `ms`). */
export function jittered(ms: number, ratio: number, random: Random = Math.random): number {
  return between(ms * (1 - ratio), ms * (1 + ratio), random)
}

/** Gigue pleine : uniforme dans [0, min(plafond, base·2ⁿ)]. */
export function fullJitter(
  attempt: number,
  baseMs: number,
  capMs: number,
  random: Random = Math.random
): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(Math.max(attempt, 0), 30))
  return between(0, ceiling, random)
}

/** Retry-After plafonné : un serveur ne fait jamais attendre plus d'une heure. */
const RETRY_AFTER_CAP_MS = 60 * 60_000

/** En-tête Retry-After (secondes ou date HTTP) → millisecondes ; null s'il est absent ou illisible. */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now()
): number | null {
  if (!value) return null
  const text = value.trim()
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, RETRY_AFTER_CAP_MS)
  const date = Date.parse(text)
  if (Number.isNaN(date)) return null
  return Math.min(Math.max(date - now, 0), RETRY_AFTER_CAP_MS)
}

/** Statut HTTP d'une erreur de l'API (null : réseau, délai, erreur locale). */
export function httpStatus(error: unknown): number | null {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: unknown }).status
    if (typeof status === 'number') return status
  }
  return null
}

/** Attente demandée par le serveur (Retry-After), en millisecondes, si l'erreur en porte une. */
export function retryAfterOf(error: unknown): number | null {
  if (error && typeof error === 'object' && 'retryAfterMs' in error) {
    const value = (error as { retryAfterMs: unknown }).retryAfterMs
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  }
  return null
}

/** Le serveur est-il sous pression (trop de requêtes, maintenance, panne) ? */
export function serverBusy(error: unknown): boolean {
  const status = httpStatus(error)
  return status === 429 || (status !== null && status >= 500)
}

/**
 * Prochaine interrogation après un échec. Jamais plus tôt que le rythme normal (une panne
 * ne doit pas faire interroger plus souvent) ; si le serveur est sous pression (429, 5xx),
 * l'attente double à chaque échec (gigue pleine, plafonnée) ; jamais avant son Retry-After.
 */
export function pollRetryDelay(
  error: unknown,
  failures: number,
  intervalMs: number,
  ratio: number,
  capMs: number,
  random: Random = Math.random
): number {
  const normal = jittered(intervalMs, ratio, random)
  const backoff = serverBusy(error)
    ? Math.min(capMs, normal + fullJitter(failures - 1, intervalMs, capMs, random))
    : normal
  return Math.max(normal, backoff, retryAfterOf(error) ?? 0)
}

/**
 * Nouvel essai de montage après un échec : gigue pleine (1 s au moins, 2 min au plus),
 * jamais avant le Retry-After du serveur.
 */
export function reconnectRetryDelay(
  error: unknown,
  attempt: number,
  random: Random = Math.random
): number {
  return Math.max(1_000 + fullJitter(attempt, 5_000, 120_000, random), retryAfterOf(error) ?? 0)
}

// ── Temps réel : que faire quand la connexion tombe ─────────

/**
 * Familles de fermeture (protocole Pusher et WebSocket) :
 *  - fatal (4000–4099) : rien ne sert de réessayer tout de suite (application inconnue,
 *    accès refusé) ;
 *  - capacity (4100–4199) : serveur plein, attendre au moins 30 s ;
 *  - restart (4200–4299, 1006 perte de connexion, 1012 redémarrage) : tous les postes
 *    tombent en même temps, le premier essai s'étale sur 90 s ;
 *  - other : gigue pleine.
 */
export type CloseKind = 'fatal' | 'capacity' | 'restart' | 'other'

export function classifyClose(code: number | null | undefined): CloseKind {
  if (typeof code !== 'number') return 'other'
  if (code >= 4000 && code <= 4099) return 'fatal'
  if (code >= 4100 && code <= 4199) return 'capacity'
  if ((code >= 4200 && code <= 4299) || code === 1006 || code === 1012) return 'restart'
  return 'other'
}

export const REALTIME_BASE_MS = 2_000
export const REALTIME_CAP_MS = 60_000
export const REALTIME_RESTART_SPREAD_MS = 90_000
export const REALTIME_CAPACITY_MIN_MS = 30_000
export const REALTIME_SLOW_MIN_MS = 10 * 60_000
export const REALTIME_SLOW_MAX_MS = 20 * 60_000

/**
 * Attente avant de rouvrir la connexion temps réel. `attempt` : échecs consécutifs (remis
 * à zéro après 5 min connecté) ; `firstAfterConnected` : premier essai après une
 * connexion établie (c'est lui qui s'étale sur 90 s après un redémarrage du serveur).
 */
export function realtimeRetryDelay(
  kind: CloseKind | 'slow',
  attempt: number,
  firstAfterConnected: boolean,
  random: Random = Math.random
): number {
  switch (kind) {
    case 'fatal':
    case 'slow':
      return between(REALTIME_SLOW_MIN_MS, REALTIME_SLOW_MAX_MS, random)
    case 'capacity':
      return (
        REALTIME_CAPACITY_MIN_MS + fullJitter(attempt, REALTIME_BASE_MS, REALTIME_CAP_MS, random)
      )
    case 'restart':
      return firstAfterConnected
        ? between(0, REALTIME_RESTART_SPREAD_MS, random)
        : fullJitter(attempt, REALTIME_BASE_MS, REALTIME_CAP_MS, random)
    default:
      return fullJitter(attempt, REALTIME_BASE_MS, REALTIME_CAP_MS, random)
  }
}
