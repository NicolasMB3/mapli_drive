import { open, stat } from 'fs/promises'

/*
 * Journal de rclone (niveau NOTICE : avertissements et erreurs seulement), à part pour être
 * testé : borné à 10 Mo — au-delà, seule la fin est gardée —, et lu par la fin seulement
 * quand il faut expliquer un échec de montage.
 */

export const LOG_MAX_BYTES = 10 * 1024 * 1024
/** Ce qui reste d'un journal raccourci : la fin, utile pour comprendre un échec. */
export const LOG_KEEP_BYTES = 256 * 1024
export const LOG_TAIL_BYTES = 64 * 1024

/** Raccourcit le journal s'il dépasse `maxBytes` (garde ses `keepBytes` derniers octets). */
export async function trimLog(
  file: string,
  maxBytes: number = LOG_MAX_BYTES,
  keepBytes: number = LOG_KEEP_BYTES
): Promise<boolean> {
  let size: number
  try {
    size = (await stat(file)).size
  } catch {
    return false
  }
  if (size <= maxBytes) return false

  const handle = await open(file, 'r+')
  try {
    const keep = Math.min(keepBytes, size)
    const buffer = Buffer.alloc(keep)
    await handle.read(buffer, 0, keep, size - keep)
    // Une ligne entière pour commencer.
    const newline = buffer.indexOf(0x0a)
    const tail = newline >= 0 && newline < keep - 1 ? buffer.subarray(newline + 1) : buffer
    await handle.truncate(0)
    await handle.write(tail, 0, tail.length, 0)
    return true
  } finally {
    await handle.close()
  }
}

/** Les derniers octets du journal (texte), sans lire le fichier entier. */
export async function readLogTail(
  file: string,
  maxBytes: number = LOG_TAIL_BYTES
): Promise<string> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return ''
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(maxBytes, size)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}
