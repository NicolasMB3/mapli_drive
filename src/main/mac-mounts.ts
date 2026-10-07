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

/** Volume WebDAV de cette adresse actuellement monté (macOS), ou null. */
export function findWebdavMount(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/sbin/mount', [], { timeout: 5_000 }, (error, stdout) =>
      resolve(error ? null : parseWebdavMount(String(stdout), url))
    )
  })
}
