import { spawn, execFile, execFileSync, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { readdir } from 'fs/promises'
import http from 'http'
import { createServer } from 'net'
import { join } from 'path'
import { app } from 'electron'
import type { Transfer } from '../shared/types'
import { VOLUME_NAME } from './config'
import { notifyShell } from './explorer-notify'
import { shellChangesFor } from './shell-changes'
import { getRclonePath, isMountReady, IS_MAC, IS_WIN, mountPathForOpen } from './platform'
import { rcloneMountArgs, rcloneMountEnv } from './rclone-args'

/*
 * Montage du coffre-fort en lecteur :
 *  - Windows : rclone (avec WinFsp, installé par l'installateur), lettre de lecteur,
 *    cache local des fichiers ouverts, écriture différée de 3 s ;
 *  - macOS : le client WebDAV du système (Finder), sans extension noyau.
 * Le démontage attend la fin des envois en cours : un fichier enregistré juste avant de
 * quitter part quand même.
 */

const MOUNT_TIMEOUT_MS = 30_000
const UPLOAD_FLUSH_TIMEOUT_MS = 30_000

export interface MountRequest {
  davUrl: string
  finderUrl: string
  token: string
  mountPoint: string
  cacheSizeGb: number
}

export interface MountStats {
  transfers: Transfer[]
  pendingUploads: number
  /** Transferts terminés depuis le démarrage de rclone. */
  completed: number
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('Port indisponible'))
      )
    })
  })
}

/** Échappement d'une chaîne AppleScript entre guillemets. */
function appleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export class DriveMount {
  private proc: ChildProcess | null = null
  private rc: { port: number; user: string; pass: string } | null = null
  private mountedPath: string | null = null

  /** Monte le lecteur ; renvoie le chemin réellement monté. */
  async mount(request: MountRequest, onExit?: (code: number | null) => void): Promise<string> {
    await this.unmount()

    return IS_MAC ? this.mountMac(request) : this.mountWindows(request, onExit)
  }

  isMounted(): boolean {
    return this.mountedPath !== null && isMountReady(this.mountedPath)
  }

  get path(): string | null {
    return this.mountedPath
  }

  async stats(): Promise<MountStats> {
    if (!this.rc) return { transfers: [], pendingUploads: 0, completed: 0 }

    try {
      const [core, vfs] = await Promise.all([
        this.rcPost<{ transferring?: Transfer[]; transfers?: number }>('core/stats'),
        this.rcPost<{ diskCache?: { uploadsInProgress?: number; uploadsQueued?: number } }>(
          'vfs/stats'
        )
      ])
      return {
        transfers: (core.transferring ?? []).map((t) => ({
          name: t.name,
          bytes: t.bytes ?? 0,
          size: t.size ?? 0,
          percentage: t.percentage ?? 0,
          speed: t.speed ?? 0
        })),
        pendingUploads:
          (vfs.diskCache?.uploadsInProgress ?? 0) + (vfs.diskCache?.uploadsQueued ?? 0),
        completed: core.transfers ?? 0
      }
    } catch {
      return { transfers: [], pendingUploads: 0, completed: 0 }
    }
  }

  /**
   * Après un changement fait ailleurs (web, autre poste) : rclone oublie ses listes de
   * dossiers (la prochaine lecture repart du serveur), puis l'Explorateur est prévenu,
   * pour que son volet de navigation retire les dossiers disparus et montre les
   * nouveaux. Renvoie les dossiers de premier niveau actuels (null si illisibles).
   * Windows seulement : le Finder relit le volume WebDAV de lui-même.
   */
  async refreshExplorer(previous: string[] | null): Promise<string[] | null> {
    const path = this.mountedPath
    if (!path || !IS_WIN || !this.rc) return null

    try {
      await this.rcPost('vfs/forget')
    } catch {
      // Port de contrôle injoignable : les listes se rafraîchiront d'elles-mêmes (30 s).
    }
    const current = await this.topLevelFolders()
    if (current === null) return previous

    await notifyShell(shellChangesFor(mountPathForOpen(path), previous, current))
    return current
  }

  /** Noms des dossiers à la racine du lecteur (null si le lecteur est illisible). */
  async topLevelFolders(): Promise<string[] | null> {
    const path = this.mountedPath
    if (!path) return null
    try {
      const entries = await readdir(mountPathForOpen(path), { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return null
    }
  }

  /** Démonte proprement, après les envois en attente (30 s au plus). */
  async unmount(): Promise<void> {
    const path = this.mountedPath
    this.mountedPath = null

    if (IS_MAC) {
      if (path) await this.unmountMac(path)
      return
    }

    const proc = this.proc
    if (!proc) return

    const deadline = Date.now() + UPLOAD_FLUSH_TIMEOUT_MS
    while (this.rc && Date.now() < deadline) {
      const { pendingUploads } = await this.stats()
      if (pendingUploads === 0) break
      await sleep(500)
    }

    try {
      await this.rcPost('core/quit')
    } catch {
      // Port de contrôle déjà fermé.
    }

    const exited = await Promise.race([
      new Promise<boolean>((resolve) => proc.once('exit', () => resolve(true))),
      sleep(5_000).then(() => false)
    ])
    if (!exited && !proc.killed) proc.kill()

    this.proc = null
    this.rc = null
  }

  /** À la fermeture de l'application : arrêt immédiat, sans attente. */
  killSync(): void {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill()
      } catch {
        // déjà arrêté
      }
    }
    if (IS_MAC && this.mountedPath) {
      try {
        execFileSync('diskutil', ['unmount', this.mountedPath], { timeout: 5_000 })
      } catch {
        // déjà démonté
      }
    }
    this.proc = null
    this.rc = null
    this.mountedPath = null
  }

  /** Processus rclone laissés par une session précédente (plantage) : arrêtés avant de remonter. */
  static killOrphans(): void {
    if (!IS_WIN) return
    const binary = getRclonePath().replace(/'/g, "''")
    try {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-WindowStyle',
          'Hidden',
          '-Command',
          `Get-Process rclone -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${binary}' } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }`
        ],
        { windowsHide: true, timeout: 10_000 }
      )
    } catch {
      // aucun processus
    }
  }

  private async mountWindows(
    request: MountRequest,
    onExit?: (code: number | null) => void
  ): Promise<string> {
    const rclone = getRclonePath()
    if (!existsSync(rclone)) {
      throw new Error('L’outil de montage est absent. Réinstallez Mapli Drive.')
    }

    const dir = app.getPath('userData')
    const configFile = join(dir, 'rclone.conf')
    if (!existsSync(configFile)) writeFileSync(configFile, '')
    const cacheDir = join(dir, 'cache')
    mkdirSync(cacheDir, { recursive: true })
    const logFile = join(dir, 'rclone.log')

    const rc = {
      port: await freePort(),
      user: randomBytes(12).toString('hex'),
      pass: randomBytes(24).toString('hex')
    }
    const options = {
      davUrl: request.davUrl,
      token: request.token,
      mountPoint: request.mountPoint,
      volumeName: VOLUME_NAME,
      rcPort: rc.port,
      rcUser: rc.user,
      rcPass: rc.pass,
      cacheDir,
      cacheSizeGb: request.cacheSizeGb,
      logFile,
      configFile,
      userAgent: `MapliDrive/${app.getVersion()}`
    }

    const proc = spawn(rclone, rcloneMountArgs(options), {
      env: rcloneMountEnv(options),
      windowsHide: true,
      stdio: 'ignore'
    })
    this.proc = proc
    this.rc = rc

    proc.on('exit', (code) => {
      if (this.proc !== proc) return
      this.proc = null
      this.rc = null
      this.mountedPath = null
      onExit?.(code)
    })

    const deadline = Date.now() + MOUNT_TIMEOUT_MS
    while (Date.now() < deadline && proc.exitCode === null) {
      await sleep(400)
      if (isMountReady(request.mountPoint)) {
        this.mountedPath = request.mountPoint
        return request.mountPoint
      }
    }

    try {
      proc.kill()
    } catch {
      // déjà arrêté
    }
    this.proc = null
    this.rc = null
    throw new Error(this.explainFailure(logFile))
  }

  /** Message compréhensible à partir du journal de rclone. */
  private explainFailure(logFile: string): string {
    let log = ''
    try {
      log = readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n')
    } catch {
      // pas de journal
    }

    if (/winfsp|cgofuse/i.test(log))
      return 'Le composant WinFsp est manquant. Réinstallez Mapli Drive.'
    if (/401|unauthori/i.test(log))
      return 'Mapli a refusé la connexion de ce poste. Reliez-le à nouveau.'
    if (/already in use|mountpoint .* exists|is already mounted/i.test(log))
      return 'Cette lettre de lecteur est déjà utilisée. Choisissez-en une autre dans les réglages.'
    if (/no such host|connection refused|timeout|i\/o timeout/i.test(log))
      return 'Mapli est injoignable. Vérifiez votre connexion internet.'

    return 'Le lecteur n’a pas pu être monté. Réessayez dans un instant.'
  }

  private mountMac(request: MountRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      // Le token part par l'entrée standard d'osascript (jamais dans la liste des processus).
      const script = [
        `set vol to mount volume "${appleScriptString(request.finderUrl)}" as user name "mapli" with password "${appleScriptString(request.token)}"`,
        'return POSIX path of vol'
      ].join('\n')

      const proc = spawn('osascript', [], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))

      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error('Le montage a pris trop de temps. Réessayez dans un instant.'))
      }, MOUNT_TIMEOUT_MS)

      proc.on('close', (code) => {
        clearTimeout(timer)
        const path = stdout.trim().replace(/\/+$/, '')
        if (code !== 0 || !path) {
          reject(
            new Error(
              /-128|annul/i.test(stderr)
                ? 'Montage annulé.'
                : 'Le lecteur n’a pas pu être monté. Réessayez dans un instant.'
            )
          )
          return
        }
        this.mountedPath = path
        resolve(path)
      })

      proc.stdin.write(script)
      proc.stdin.end()
    })
  }

  private unmountMac(path: string): Promise<void> {
    return new Promise((resolve) => {
      execFile('diskutil', ['unmount', path], { timeout: 10_000 }, (error) => {
        if (!error) return resolve()
        execFile('diskutil', ['unmount', 'force', path], { timeout: 10_000 }, () => resolve())
      })
    })
  }

  private rcPost<T = unknown>(endpoint: string, body: Record<string, unknown> = {}): Promise<T> {
    const rc = this.rc
    if (!rc) return Promise.reject(new Error('rclone arrêté'))

    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: rc.port,
          path: `/${endpoint}`,
          method: 'POST',
          timeout: 5_000,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            Authorization: `Basic ${Buffer.from(`${rc.user}:${rc.pass}`).toString('base64')}`
          }
        },
        (res) => {
          let raw = ''
          res.on('data', (chunk: Buffer) => (raw += chunk.toString()))
          res.on('end', () => {
            if ((res.statusCode ?? 500) >= 400)
              return reject(new Error(`rc ${endpoint}: ${res.statusCode}`))
            try {
              resolve(JSON.parse(raw || '{}') as T)
            } catch {
              reject(new Error(`rc ${endpoint}: réponse illisible`))
            }
          })
        }
      )
      req.on('timeout', () => req.destroy(new Error(`rc ${endpoint}: délai dépassé`)))
      req.on('error', reject)
      req.write(data)
      req.end()
    })
  }
}
