import { readFile, unlink, writeFile } from 'fs/promises'
import { join } from 'path'

/*
 * rclone laissé par une session précédente (plantage, arrêt forcé) : il tient encore la
 * lettre du lecteur, le nouveau montage échouerait. Son PID est noté à chaque montage et
 * effacé à l'arrêt ; au démarrage, s'il reste noté et que ce processus est toujours un
 * rclone, il est arrêté — sans bloquer le démarrage (tout est asynchrone). Sans Electron,
 * pour être testé : l'inspection et l'arrêt des processus sont fournis par l'appelant.
 */

export const PID_FILE = 'rclone.pid'

export interface ProcessProbe {
  /** Nom de l'image du processus (« rclone.exe »), null s'il n'existe plus. */
  imageName(pid: number): Promise<string | null>
  kill(pid: number): void
  alive(pid: number): boolean
  sleep(ms: number): Promise<void>
}

export async function recordPid(dir: string, pid: number): Promise<void> {
  try {
    await writeFile(join(dir, PID_FILE), String(pid))
  } catch {
    // Dossier en lecture seule : pas de nettoyage au prochain démarrage, rien de plus.
  }
}

/** Efface le PID noté (seulement s'il s'agit bien de `pid`, quand il est donné). */
export async function clearPid(dir: string, pid?: number): Promise<void> {
  const file = join(dir, PID_FILE)
  try {
    if (pid !== undefined && (await readFile(file, 'utf8')).trim() !== String(pid)) return
    await unlink(file)
  } catch {
    // déjà effacé
  }
}

export async function recordedPid(dir: string): Promise<number | null> {
  try {
    const pid = Number((await readFile(join(dir, PID_FILE), 'utf8')).trim())
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

export type OrphanOutcome = 'none' | 'killed' | 'gone' | 'other-process'

/** Arrête le rclone noté s'il tourne encore, et attend qu'il ait libéré le lecteur (5 s au plus). */
export async function killRecordedOrphan(
  dir: string,
  probe: ProcessProbe,
  expectedImage = 'rclone.exe'
): Promise<OrphanOutcome> {
  const pid = await recordedPid(dir)
  if (pid === null) return 'none'
  try {
    const image = await probe.imageName(pid)
    if (image === null) return 'gone'
    // PID réattribué à un autre programme : on n'y touche pas.
    if (image.toLowerCase() !== expectedImage.toLowerCase()) return 'other-process'
    try {
      probe.kill(pid)
    } catch {
      return 'gone'
    }
    for (let waited = 0; waited < 5_000 && probe.alive(pid); waited += 100) await probe.sleep(100)
    return 'killed'
  } finally {
    await clearPid(dir, pid)
  }
}

/** Sortie de « tasklist /FO CSV /NH » → nom de l'image (null : aucun processus). */
export function parseTasklist(output: string): string | null {
  const line = output.split(/\r?\n/).find((l) => l.startsWith('"'))
  if (!line) return null
  const match = /^"([^"]+)"/.exec(line)
  return match ? match[1] : null
}
