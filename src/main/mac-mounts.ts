import { execFile } from 'child_process'

/** Adresse comparable : schéma et hôte en minuscules, sans barre finale. */
function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase()
  } catch {
    return url.replace(/\/+$/, '').toLowerCase()
  }
}

/**
 * Point de montage d'un volume WebDAV dans la sortie de `mount` (macOS), par son adresse :
 * « https://app.mapli.fr/Mapli/ on /Volumes/Mapli (webdav, nodev, …) ». Null s'il n'y est pas.
 */
export function parseWebdavMount(mountOutput: string, url: string): string | null {
  const wanted = normalizeUrl(url)
  for (const line of mountOutput.split('\n')) {
    const match = /^(.+?) on (.+) \(webdav[,)]/.exec(line.trim())
    if (match && normalizeUrl(match[1]) === wanted) return match[2]
  }
  return null
}

/**
 * Un volume de ce type est-il monté sur ce dossier ? Dans la sortie de `mount` :
 * « localhost:/ on /Users/…/Mapli (nfs, nodev, nosuid, mounted by …) » (le chemin peut
 * contenir des espaces).
 */
export function hasMountAt(
  mountOutput: string,
  mountPoint: string,
  type: 'nfs' | 'webdav'
): boolean {
  const wanted = mountPoint.replace(/\/+$/, '')
  return mountOutput.split('\n').some((line) => {
    const match = /^.+? on (.+) \(([a-z]+)[,)]/.exec(line.trim())
    return match !== null && match[2] === type && match[1].replace(/\/+$/, '') === wanted
  })
}

export function hasNfsMount(mountOutput: string, mountPoint: string): boolean {
  return hasMountAt(mountOutput, mountPoint, 'nfs')
}

/** Sortie de `mount` (la table des volumes, sans toucher à aucun d'eux) ; null en cas d'échec. */
export function mountTable(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/sbin/mount', [], { timeout: 5_000 }, (error, stdout) =>
      resolve(error ? null : String(stdout))
    )
  })
}

/** Volume WebDAV de cette adresse actuellement monté (macOS), ou null. */
export async function findWebdavMount(url: string): Promise<string | null> {
  const table = await mountTable()
  return table === null ? null : parseWebdavMount(table, url)
}

/** Le lecteur NFS est-il monté sur ce dossier ? (null : table illisible). */
export async function nfsMounted(mountPoint: string): Promise<boolean | null> {
  const table = await mountTable()
  return table === null ? null : hasMountAt(table, mountPoint, 'nfs')
}

/** Le volume WebDAV (repli) est-il toujours monté à cet endroit ? (null : table illisible). */
export async function webdavMounted(mountPoint: string): Promise<boolean | null> {
  const table = await mountTable()
  return table === null ? null : hasMountAt(table, mountPoint, 'webdav')
}
