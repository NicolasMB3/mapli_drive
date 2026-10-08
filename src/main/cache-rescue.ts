import { copyFile, mkdir, readdir, readFile } from 'fs/promises'
import { dirname, join, relative, sep } from 'path'
import { isSystemFile, isTemporaryFile } from './upload-queue'

/*
 * Avant d'effacer le cache de rclone (poste déconnecté) : les fichiers enregistrés sur le
 * lecteur mais pas encore envoyés n'existent que là. Ils sont copiés à l'abri, dans
 * Documents, avec l'arborescence du coffre. Sans Electron, pour être testé.
 *
 * Disposition du cache (--cache-dir) : <cache>/vfsMeta/<remote>/<chemin> pour les
 * métadonnées (JSON, « Dirty » tant que l'envoi n'est pas fait) et <cache>/vfs/<remote>/
 * <chemin> pour le contenu ; <remote> est le nom du remote suffixé de l'empreinte de sa
 * configuration (« :webdav{AbCdE} »), propre au token du poste.
 */

/** Dossier, dans Documents, où sont mis de côté les fichiers non envoyés. */
export const RESCUE_FOLDER = 'Mapli Drive – fichiers non envoyés'

export interface UnsentFile {
  /** Chemin dans le coffre (« Clients/Devis.pdf »). */
  path: string
  /** Contenu, dans le cache. */
  data: string
}

async function* files(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* files(full)
    else if (entry.isFile()) yield full
  }
}

/** Fichiers de l'utilisateur pas encore envoyés, dans ce dossier de cache. */
export async function findUnsent(cacheDir: string): Promise<UnsentFile[]> {
  const metaRoot = join(cacheDir, 'vfsMeta')
  const found: UnsentFile[] = []
  let remotes
  try {
    remotes = await readdir(metaRoot, { withFileTypes: true })
  } catch {
    return found
  }
  for (const remote of remotes) {
    if (!remote.isDirectory()) continue
    const base = join(metaRoot, remote.name)
    for await (const meta of files(base)) {
      const path = relative(base, meta).split(sep).join('/')
      // Fichiers du système et temporaires : rien que l'utilisateur ait à retrouver.
      if (isSystemFile(path) || isTemporaryFile(path)) continue
      try {
        const info = JSON.parse(await readFile(meta, 'utf8')) as { Dirty?: unknown }
        if (info.Dirty === true)
          found.push({ path, data: join(cacheDir, 'vfs', remote.name, ...path.split('/')) })
      } catch {
        // Métadonnée illisible : rien à en tirer.
      }
    }
  }
  return found
}

/** Copie ces fichiers sous `target`, arborescence conservée ; renvoie le nombre copié. */
export async function rescueUnsent(unsent: UnsentFile[], target: string): Promise<number> {
  let copied = 0
  for (const file of unsent) {
    const destination = join(target, ...file.path.split('/'))
    try {
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(file.data, destination)
      copied += 1
    } catch {
      // Contenu absent du cache : compté comme non copié.
    }
  }
  return copied
}

/** Nom du dossier d'un sauvetage : la date et l'heure (« 2026-10-08 01h05 »). */
export function rescueStamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}h${pad(date.getMinutes())}`
}

/** Phrase pour la personne : fichiers non envoyés mis de côté (ou gardés), null s'il n'y en avait pas. */
export function rescueNotice(unsent: number, rescued: number): string | null {
  if (unsent === 0) return null
  const one = unsent === 1
  const files = one
    ? '1 fichier déposé sur ce poste n’était pas encore envoyé'
    : `${unsent} fichiers déposés sur ce poste n’étaient pas encore envoyés`
  if (rescued === unsent)
    return `${files} : ${one ? 'il a été mis' : 'ils ont été mis'} de côté dans Documents › ${RESCUE_FOLDER}.`
  return `${files} : ${one ? 'il reste' : 'ils restent'} dans le cache de Mapli Drive, sur ce poste.`
}
