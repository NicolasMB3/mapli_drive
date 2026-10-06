import { ApiError, NetworkError, UserFacingError } from './errors'

/*
 * Ce que la fenêtre dit quand quelque chose échoue : toujours en français, court et sans
 * jargon. Le détail technique (souvent en anglais : Node, Chromium, framework du serveur,
 * proxy) reste dans la console. Sans dépendance Electron : testé.
 */

/** D'où vient l'erreur : la phrase de repli en dépend. */
export type ErrorContext = 'pairing' | 'connect' | 'space'

export const OFFLINE_MESSAGE = 'Mapli est injoignable. Vérifiez votre connexion internet.'
export const UNEXPECTED_MESSAGE = 'Une erreur inattendue est survenue. Réessayez dans un instant.'

const CONTEXT_MESSAGE: Record<ErrorContext, string> = {
  pairing: 'L’appairage n’a pas abouti. Réessayez dans un instant.',
  connect: 'Le lecteur n’a pas pu être monté. Réessayez dans un instant.',
  space: 'L’action n’a pas abouti. Réessayez dans un instant.'
}

/** Le message à montrer pour une erreur, en français, quelle qu'en soit l'origine. */
export function toUserMessage(error: unknown, context?: ErrorContext): string {
  if (error instanceof UserFacingError && error.message) return error.message
  if (error instanceof NetworkError) return OFFLINE_MESSAGE
  if (error instanceof ApiError) {
    // Le serveur répond d'ordinaire en français ; son framework ou un proxy, parfois en anglais.
    const server = error.serverMessage?.trim()
    return server && looksFrench(server) ? server : statusMessage(error.status, context)
  }
  return systemMessage(error) ?? (context ? CONTEXT_MESSAGE[context] : UNEXPECTED_MESSAGE)
}

/** Un texte venu du serveur s'il est en français, sinon la phrase prévue (succès d'une action…). */
export function frenchOr(text: unknown, fallback: string): string {
  const value = typeof text === 'string' ? text.trim() : ''
  return value && looksFrench(value) ? value : fallback
}

/** Statut HTTP → phrase, quand le serveur n'a rien dit d'utilisable (ou l'a dit en anglais). */
function statusMessage(status: number, context?: ErrorContext): string {
  switch (status) {
    case 401:
      if (context === 'pairing') return CONTEXT_MESSAGE.pairing
      return 'Ce poste n’est plus autorisé par Mapli. Reliez-le à nouveau.'
    case 403:
      return 'Accès refusé. Demandez l’accès à un administrateur de votre organisation.'
    case 404:
      if (context === 'space')
        return 'Introuvable : ce document ou ce dossier a peut-être déjà été traité.'
      break
    case 408:
    case 504:
      return 'Mapli met trop de temps à répondre. Réessayez dans un instant.'
    case 413:
      return 'La demande est trop volumineuse pour Mapli.'
    case 422:
      return 'Certaines informations ne sont pas valides. Vérifiez-les, puis réessayez.'
    case 429:
      return 'Trop de tentatives. Patientez un instant, puis réessayez.'
    case 502:
    case 503:
      return 'Mapli est momentanément indisponible. Réessayez dans quelques minutes.'
  }
  if (status >= 500) return 'Mapli a rencontré un problème. Réessayez dans quelques minutes.'
  return context ? CONTEXT_MESSAGE[context] : UNEXPECTED_MESSAGE
}

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'EPIPE'
])
const NETWORK_TEXT = /fetch failed|failed to fetch|net::ERR_|socket hang up|getaddrinfo|network/i

/** Erreurs du système (Node, Chromium) : codes connus → phrase ; null sinon. */
function systemMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null
  const code = 'code' in error && typeof error.code === 'string' ? error.code : ''
  if (NETWORK_CODES.has(code)) return OFFLINE_MESSAGE
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'Accès refusé par le système de ce poste. Redémarrez-le, puis réessayez.'
    case 'ENOSPC':
      return 'Le disque de ce poste est plein. Libérez de la place, puis réessayez.'
    case 'EBUSY':
      return 'Un fichier de Mapli Drive est utilisé par un autre programme. Réessayez dans un instant.'
  }
  return NETWORK_TEXT.test(error.message) ? OFFLINE_MESSAGE : null
}

// ── Le texte est-il en français ? ─────────────────────────

/*
 * Mots-outils propres à chaque langue (aucun mot commun aux deux : « action », « service »,
 * « document », « code »…), et quelques mots fréquents dans les messages d'erreur.
 */
const FRENCH_WORDS = new Set(
  (
    'le la les un une des du de au aux et ou où est sont été être pas ne ni vous votre vos ' +
    'nous notre nos ce cet cette ces ça cela ceci en dans sur sous pour par avec sans chez ' +
    'entre vers depuis qui que quoi il elle ils elles lui leur leurs sa ses mon ma mes mais ' +
    'donc très trop déjà encore aussi aucun aucune peut doit sera était avez êtes fait merci ' +
    'veuillez réessayez erreur introuvable invalide obligatoire requis indisponible interdit ' +
    'inconnu inconnue manquant manquante fichier fichiers coffre poste appareil compte offre ' +
    'espace accès salarié salariés'
  ).split(' ')
)

const ENGLISH_WORDS = new Set(
  (
    'the an is are was were be been being am has have had do does did done this that these ' +
    'those it its there their they we our you your he she his her to of and or for with from ' +
    'by at in into onto as than then if not no nor any some all more many much too very only ' +
    'also can cannot could should would will shall may might must please try again later ' +
    'unable failed failure error errors invalid valid required missing already exists exist ' +
    'unknown unexpected something went wrong found denied expired allowed forbidden ' +
    'unauthorized unauthenticated unavailable unprocessable server request requests response ' +
    'timeout timed gateway internal bad conflict gone payload entity attempt attempts given ' +
    'method methods supported query results model field fields address selected network ' +
    'connection refused reset host access file folder user name mismatch limit exceeded rate ' +
    'throttled what which when while where who why how about over under after before because ' +
    'out up down off here such each other'
  ).split(' ')
)

/** Lettres accentuées et guillemets du français. */
const FRENCH_SIGNS = /[àâäçéèêëîïôöœùûüÿ«»]/
/** Élision en tête de mot : l’accès, d’un, n’avez, qu’il… */
const ELISION = /^(?:c|d|j|l|m|n|qu|s|t)['’]/
/** Chemins, adresses, identifiants, nombres : ni français ni anglais. */
const TECHNICAL = /[\d\\/_@[\]{}<>=$#|]/

/**
 * Le texte a-t-il l'air français ? Plus d'indices français (mots-outils, élisions, accents)
 * que de mots anglais. Dans le doute, non : la phrase de repli, elle, est française.
 */
export function looksFrench(text: string): boolean {
  let french = 0
  let english = 0
  let signs = false
  for (const raw of text.toLowerCase().split(/\s+/)) {
    if (!raw || TECHNICAL.test(raw)) continue
    let token = raw
    if (FRENCH_SIGNS.test(token)) signs = true
    if (ELISION.test(token)) {
      french += 1
      token = token.replace(ELISION, '')
    }
    for (const word of token.split(/[^a-zàâäçéèêëîïôöœùûüÿ]+/)) {
      if (FRENCH_WORDS.has(word)) french += 1
      else if (ENGLISH_WORDS.has(word)) english += 1
    }
  }
  return french + (signs ? 1 : 0) > english
}
