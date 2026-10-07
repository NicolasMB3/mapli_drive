import { createWriteStream, mkdirSync, renameSync, statSync, type WriteStream } from 'fs'
import { join } from 'path'
import { app } from 'electron'

/*
 * Journal de Mapli Drive, pour comprendre un problème après coup : montage (méthode, durée),
 * arrêts de rclone, santé du lecteur, reconnexions, temps réel, mises à jour, erreurs.
 *  - macOS : ~/Library/Logs/<application>/main.log ; Windows : %APPDATA%\<application>\logs.
 *  - Une ligne par événement, horodatée en UTC ; borné à 5 Mo (l'ancien passe en
 *    main.old.log). Écrit par un flux en ajout : jamais d'attente du processus principal.
 *  - Jamais de token ni de mot de passe : les messages sont rédigés par l'application, et
 *    `redact` masque ce qui ressemble à un jeton dans un texte venu d'ailleurs.
 */

const MAX_BYTES = 5 * 1024 * 1024
/** Taille vérifiée toutes les N lignes (la rotation se fait au lancement et en cours de route). */
const CHECK_EVERY = 200

type Level = 'info' | 'warn' | 'error'

let stream: WriteStream | null = null
let file: string | null = null
let written = 0

export function logDirectory(): string {
  return app.getPath('logs')
}

function open(): WriteStream | null {
  if (stream) return stream
  try {
    const dir = logDirectory()
    mkdirSync(dir, { recursive: true })
    file = join(dir, 'main.log')
    rotateIfLarge(file)
    stream = createWriteStream(file, { flags: 'a' })
    stream.on('error', () => {
      // Disque plein, dossier retiré… : le journal se tait, l'application continue.
      stream = null
    })
    return stream
  } catch {
    return null
  }
}

function rotateIfLarge(path: string): void {
  try {
    if (statSync(path).size > MAX_BYTES) renameSync(path, path.replace(/\.log$/, '.old.log'))
  } catch {
    // Pas encore de journal.
  }
}

/** Masque les jetons (Bearer, identifiants Sanctum « 12|… », longues suites hexadécimales). */
export function redact(text: string): string {
  return text
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[masqué]')
    .replace(/\b\d+\|[A-Za-z0-9]{20,}\b/g, '[jeton masqué]')
    .replace(/(password|pass|token)(["'=:\s]+)[^\s"',;]+/gi, '$1$2[masqué]')
}

function format(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function write(level: Level, message: string, detail?: unknown): void {
  const text = redact(detail === undefined ? message : `${message} — ${format(detail)}`)
  if (!app.isPackaged) {
    const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
    out(`[Mapli Drive] ${text}`)
  }
  const target = open()
  if (!target) return
  target.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${text}\n`)
  if (++written % CHECK_EVERY === 0 && file) {
    try {
      if (statSync(file).size > MAX_BYTES) {
        stream?.end()
        stream = null
      }
    } catch {
      // Taille illisible : on réessaiera.
    }
  }
}

export const log = {
  info: (message: string, detail?: unknown): void => write('info', message, detail),
  warn: (message: string, detail?: unknown): void => write('warn', message, detail),
  error: (message: string, detail?: unknown): void => write('error', message, detail)
}

/** Durée écoulée depuis `start` (ms), pour les lignes du journal. */
export function since(start: number): string {
  const ms = Date.now() - start
  return ms < 1_000 ? `${ms} ms` : `${(ms / 1_000).toFixed(1)} s`
}
