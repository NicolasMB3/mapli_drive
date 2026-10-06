import { spawn, execFile, execFileSync, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { readdir } from 'fs/promises'
import http from 'http'
import { createServer } from 'net'
import { join } from 'path'
import { app } from 'electron'
import type { Transfer } from '../shared/types'
import { VOLUME_NAME } from './config'
import { UserFacingError } from './errors'
import { helperArgs, ShellNotifier } from './explorer-notify'
import { forgetParams, TRASH_FOLDER, type InvalidationPlan } from './invalidation'
import {
  killRecordedOrphan,
  parseTasklist,
  recordPid,
  clearPid,
  type ProcessProbe
} from './orphans'
import { shellChangesFor, type ShellChange } from './shell-changes'
import {
  getRclonePath,
  getShellHelperPath,
  IS_MAC,
  IS_WIN,
  mountPathForOpen,
  probePath,
  systemTool
} from './platform'
import { rcloneMountArgs, rcloneMountEnv } from './rclone-args'
import { readLogTail, trimLog } from './rclone-log'
import { markPidTracking, needsLegacyOrphanSweep } from './session'

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
/** Délai de réponse du port de contrôle de rclone pour le juger en vie. */
const HEALTH_TIMEOUT_MS = 5_000
/** Journal de rclone surveillé (taille) au plus une fois par heure. */
const LOG_CHECK_MS = 60 * 60_000

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
  /** Erreurs comptées par rclone, et la dernière (ex. un 401 : le poste a été révoqué). */
  errors: number
  lastError: string | null
}

const NO_STATS: MountStats = {
  transfers: [],
  pendingUploads: 0,
  completed: 0,
  errors: 0,
  lastError: null
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Processus du poste vus par tasklist (sans PowerShell), pour le nettoyage au démarrage. */
const windowsProcesses: ProcessProbe = {
  imageName: (pid) =>
    new Promise((resolve) => {
      execFile(
        systemTool('tasklist.exe'),
        ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
        { windowsHide: true, timeout: 5_000 },
        (error, stdout) => resolve(error ? null : parseTasklist(String(stdout)))
      )
    }),
  kill: (pid) => process.kill(pid),
  alive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  sleep
}

/** Chemin Windows d'un dossier du lecteur (« Clients/Factures » → « M:\Clients\Factures »). */
function windowsPath(root: string, relative: string): string {
  return relative ? root + relative.replace(/\//g, '\\') : root
}

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
  /** Dossiers de premier niveau à la dernière lecture de la racine (null : pas encore lue). */
  private topFolders: string[] | null = null
  private logFile: string | null = null
  private logCheckedAt = 0

  /** Un seul assistant de notification de l'Explorateur pour toute la session (Windows). */
  private readonly notifier = new ShellNotifier({
    spawn: () =>
      spawn(
        systemTool('WindowsPowerShell\\v1.0\\powershell.exe'),
        helperArgs(getShellHelperPath()),
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
      ),
    log: (message) => console.warn(`[Mapli Drive] ${message}`)
  })

  /** Monte le lecteur ; renvoie le chemin réellement monté. */
  async mount(request: MountRequest, onExit?: (code: number | null) => void): Promise<string> {
    await this.unmount()
    this.topFolders = null

    return IS_MAC ? this.mountMac(request) : this.mountWindows(request, onExit)
  }

  get path(): string | null {
    return this.mountedPath
  }

  /**
   * Le lecteur répond-il ? Sans jamais bloquer le processus principal : sous Windows, le
   * port de contrôle de rclone (délai de 5 s) ; sous macOS, la présence du volume (un
   * serveur lent ne compte pas comme un démontage).
   */
  async healthy(): Promise<boolean> {
    const path = this.mountedPath
    if (!path) return false
    if (IS_MAC) return (await probePath(path, HEALTH_TIMEOUT_MS)) !== 'missing'
    if (!this.proc || this.proc.exitCode !== null || !this.rc) return false
    void this.maintainLog()
    try {
      await this.rcPost('core/pid', {}, HEALTH_TIMEOUT_MS)
      return true
    } catch {
      return false
    }
  }

  async stats(): Promise<MountStats> {
    if (!this.rc) return NO_STATS

    try {
      const [core, vfs] = await Promise.all([
        this.rcPost<{
          transferring?: Transfer[]
          transfers?: number
          errors?: number
          lastError?: string
        }>('core/stats'),
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
        completed: core.transfers ?? 0,
        errors: core.errors ?? 0,
        lastError: core.lastError || null
      }
    } catch {
      return NO_STATS
    }
  }

  /** Des envois partent ou attendent (écriture différée). */
  async busy(): Promise<boolean> {
    const stats = await this.stats()
    return stats.pendingUploads > 0 || stats.transfers.length > 0
  }

  /**
   * Après un changement fait ailleurs (web, autre poste) : rclone oublie les dossiers
   * touchés (leur prochaine lecture repart du serveur), puis l'Explorateur est prévenu,
   * pour que son volet de navigation retire les dossiers disparus et montre les nouveaux.
   * « Tout oublier » relit la racine et fait relire chaque dossier de premier niveau.
   * Windows seulement : le Finder relit le volume WebDAV de lui-même.
   */
  async invalidate(plan: InvalidationPlan): Promise<void> {
    const path = this.mountedPath
    if (!path || !IS_WIN || !this.rc) return
    const root = mountPathForOpen(path)

    if (plan.all) {
      try {
        await this.rcPost('vfs/forget')
      } catch {
        // Port de contrôle injoignable : les listes se rafraîchiront d'elles-mêmes (10 min).
      }
      const current = await this.topLevelFolders()
      if (current === null) return
      this.notifier.notify(shellChangesFor(root, this.topFolders, current))
      this.topFolders = current
      return
    }

    const dirs = [...plan.dirs]
    const shell = [...plan.shell]
    // La corbeille n'apparaît qu'aux administrateurs : à la racine, si on l'y a vue.
    const trash = this.topFolders?.find((name) => name.toLowerCase() === TRASH_FOLDER.toLowerCase())
    if (plan.trash && (this.topFolders === null || trash)) {
      dirs.push(trash ?? TRASH_FOLDER)
      shell.push({ event: 'updatedir', path: trash ?? TRASH_FOLDER })
    }
    if (dirs.length > 0) {
      try {
        await this.rcPost('vfs/forget', forgetParams(dirs))
      } catch {
        // idem : le cache des dossiers expire de lui-même.
      }
    }
    this.notifier.notify(
      shell.map(
        (change): ShellChange => ({ event: change.event, path: windowsPath(root, change.path) })
      )
    )
    this.trackTopFolders(shell)
  }

  /** Dossiers de premier niveau apparus ou disparus : la prochaine relecture complète en tient compte. */
  private trackTopFolders(shell: InvalidationPlan['shell']): void {
    if (!this.topFolders) return
    for (const change of shell) {
      if (!change.path || change.path.includes('/')) continue
      if (change.event === 'rmdir')
        this.topFolders = this.topFolders.filter((name) => name !== change.path)
      else if (change.event === 'mkdir' && !this.topFolders.includes(change.path))
        this.topFolders = [...this.topFolders, change.path]
    }
  }

  /** Journal de rclone borné à 10 Mo (vérifié au plus une fois par heure). */
  private async maintainLog(): Promise<void> {
    if (!this.logFile || Date.now() - this.logCheckedAt < LOG_CHECK_MS) return
    this.logCheckedAt = Date.now()
    try {
      await trimLog(this.logFile)
    } catch {
      // Journal verrouillé : ce sera pour la prochaine fois.
    }
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

  /**
   * Démonte proprement, après les envois en attente (30 s au plus). Sans attendre quand le
   * poste a été révoqué : ces envois échoueraient ; restés dans le cache local, ils
   * repartent au prochain montage.
   */
  async unmount(waitForUploads = true): Promise<void> {
    const path = this.mountedPath
    this.mountedPath = null

    if (IS_MAC) {
      if (path) await this.unmountMac(path)
      return
    }

    const proc = this.proc
    if (!proc) return

    const deadline = waitForUploads ? Date.now() + UPLOAD_FLUSH_TIMEOUT_MS : 0
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
    this.notifier.dispose()
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

  /**
   * rclone laissé par une session précédente (plantage, arrêt forcé) : arrêté avant de
   * remonter, sans bloquer le démarrage. Par son PID, noté à chaque montage ; la première
   * fois après la mise à jour (aucun PID encore noté), une recherche par chemin, une fois.
   */
  static async cleanupOrphans(): Promise<void> {
    if (!IS_WIN) return
    const outcome = await killRecordedOrphan(app.getPath('userData'), windowsProcesses)
    if (outcome === 'none' && needsLegacyOrphanSweep()) await DriveMount.legacyOrphanSweep()
    markPidTracking()
  }

  private static legacyOrphanSweep(): Promise<void> {
    const binary = getRclonePath().replace(/'/g, "''")
    return new Promise((resolve) => {
      execFile(
        systemTool('WindowsPowerShell\\v1.0\\powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-Process rclone -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${binary}' } | ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }`
        ],
        { windowsHide: true, timeout: 10_000 },
        () => resolve()
      )
    })
  }

  private async mountWindows(
    request: MountRequest,
    onExit?: (code: number | null) => void
  ): Promise<string> {
    const rclone = getRclonePath()
    if (!existsSync(rclone)) {
      throw new UserFacingError('L’outil de montage est absent. Réinstallez Mapli Drive.')
    }

    const dir = app.getPath('userData')
    const configFile = join(dir, 'rclone.conf')
    if (!existsSync(configFile)) writeFileSync(configFile, '')
    const cacheDir = join(dir, 'cache')
    mkdirSync(cacheDir, { recursive: true })
    const logFile = join(dir, 'rclone.log')
    this.logFile = logFile
    this.logCheckedAt = Date.now()
    try {
      await trimLog(logFile)
    } catch {
      // Journal verrouillé (rclone d'une session précédente ?) : il sera raccourci plus tard.
    }

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
    // Noté pour le nettoyage au prochain démarrage si l'application s'arrêtait brutalement.
    const pid = proc.pid
    if (pid) void recordPid(dir, pid)

    proc.on('exit', (code) => {
      if (pid) void clearPid(dir, pid)
      if (this.proc !== proc) return
      this.proc = null
      this.rc = null
      this.mountedPath = null
      onExit?.(code)
    })

    // Lecteur prêt ? Vérifié sans bloquer le processus principal (le système de fichiers
    // naissant peut tarder à répondre).
    const root = mountPathForOpen(request.mountPoint)
    const deadline = Date.now() + MOUNT_TIMEOUT_MS
    while (Date.now() < deadline && proc.exitCode === null) {
      await sleep(400)
      if (proc.exitCode === null && (await probePath(root, 2_000)) === 'ok') {
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
    throw new UserFacingError(await this.explainFailure(logFile))
  }

  /** Message compréhensible à partir du journal de rclone (sa fin seulement). */
  private async explainFailure(logFile: string): Promise<string> {
    const log = (await readLogTail(logFile)).split('\n').slice(-40).join('\n')

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
        reject(new UserFacingError('Le montage a pris trop de temps. Réessayez dans un instant.'))
      }, MOUNT_TIMEOUT_MS)

      proc.on('close', (code) => {
        clearTimeout(timer)
        const path = stdout.trim().replace(/\/+$/, '')
        if (code !== 0 || !path) {
          reject(
            new UserFacingError(
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

  private rcPost<T = unknown>(
    endpoint: string,
    body: Record<string, unknown> = {},
    timeoutMs = 5_000
  ): Promise<T> {
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
          timeout: timeoutMs,
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
