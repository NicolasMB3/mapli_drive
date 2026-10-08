import { spawn, execFile, execFileSync, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, writeFileSync } from 'fs'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'fs/promises'
import { pipeline } from 'stream/promises'
import http from 'http'
import { createServer } from 'net'
import { basename, dirname, join } from 'path'
import { app, session } from 'electron'
import type { Transfer } from '../shared/types'
import { VOLUME_NAME } from './config'
import { UserFacingError } from './errors'
import { helperArgs, ShellNotifier } from './explorer-notify'
import { forgetParams, relistParams, TRASH_FOLDER, type InvalidationPlan } from './invalidation'
import { log, since } from './log'
import { findWebdavMount, nfsMounted, webdavMounted } from './mac-mounts'
import {
  killRecordedOrphan,
  parseTasklist,
  recordPid,
  clearPid,
  type ProcessProbe
} from './orphans'
import { parseProxyList } from './proxy'
import { explorerChange, explorerName, shellChangesFor } from './shell-changes'
import {
  getRclonePath,
  getShellHelperPath,
  IS_MAC,
  IS_WIN,
  legacyRcloneCacheDir,
  mountPathForOpen,
  probePath,
  rcloneCacheDir,
  systemTool
} from './platform'
import {
  rcloneMountArgs,
  rcloneMountEnv,
  rcloneNfsMountArgs,
  rcloneProxy,
  type MountOptions
} from './rclone-args'
import { readLogTail, trimLog } from './rclone-log'
import { markPidTracking, needsLegacyOrphanSweep } from './session'
import { findUnsent, RESCUE_FOLDER, rescueStamp, rescueUnsent } from './cache-rescue'
import {
  ancestorDirs,
  EMPTY_QUEUE,
  refusalReason,
  summarizeQueue,
  uploadErrors,
  type QueueItem
} from './upload-queue'

/*
 * Montage du coffre-fort en lecteur, par rclone sur les deux systèmes : cache local des
 * fichiers ouverts, écriture différée de 3 s, port de contrôle (envois en cours, oubli des
 * dossiers changés ailleurs).
 *  - Windows : WinFsp (installé par l'installateur), lettre de lecteur ;
 *  - macOS : le serveur NFS de rclone monté par le client NFS du système, dans un dossier
 *    « Mapli » du profil (ni extension noyau, ni droits d'administrateur). Repli sur le
 *    client WebDAV du Finder si rclone ne peut pas monter (méthode des versions ≤ 3.2).
 * Le démontage attend la fin des envois en cours : un fichier enregistré juste avant de
 * quitter part quand même.
 */

const MOUNT_TIMEOUT_MS = 30_000
const UPLOAD_FLUSH_TIMEOUT_MS = 30_000
/** Délai de réponse du port de contrôle de rclone pour le juger en vie. */
const HEALTH_TIMEOUT_MS = 5_000
/** Journal de rclone surveillé (taille) au plus une fois par heure. */
const LOG_CHECK_MS = 60 * 60_000

export type MountMethod = 'rclone' | 'webdav'

export interface MountRequest {
  davUrl: string
  finderUrl: string
  token: string
  mountPoint: string
  cacheSizeGb: number
}

export interface MountStats {
  transfers: Transfer[]
  /** Fichiers de l'utilisateur en attente d'envoi ou en cours (affichés). */
  pendingUploads: number
  /** Envois qui avancent (sans ceux qui attendent après un refus) : voir upload-queue. */
  activeUploads: number
  /** Fichiers de l'utilisateur dont l'envoi a échoué (rclone réessaie). */
  failing: string[]
  /** Transferts terminés depuis le démarrage de rclone. */
  completed: number
  /** Erreurs comptées par rclone, et la dernière (ex. un 401 : le poste a été révoqué). */
  errors: number
  lastError: string | null
}

const NO_STATS: MountStats = {
  transfers: [],
  pendingUploads: 0,
  activeUploads: 0,
  failing: [],
  completed: 0,
  errors: 0,
  lastError: null
}

/** Fichiers du système effacés au plus par passage (voir discardSystemFiles). */
const DISCARD_BATCH = 50
/** Un fichier du système dont l'effacement a échoué est réessayé après ce délai. */
const DISCARD_RETRY_MS = 5 * 60_000

/** Effacement du cache à la déconnexion (voir purgeCache). */
export interface PurgeResult {
  /** Fichiers enregistrés sur le poste et pas encore envoyés. */
  unsent: number
  /** Ceux qui ont été mis de côté, et où. */
  rescued: number
  folder: string | null
}
/** Dossiers dont le Finder est invité à relire la fenêtre, au plus, par changement. */
const FINDER_REFRESH_MAX = 200

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

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
  alive: isAlive,
  sleep
}

/** Les mêmes, vus par `ps` (macOS) : nom de l'exécutable, arrêt propre (rclone démonte). */
const macProcesses: ProcessProbe = {
  imageName: (pid) =>
    new Promise((resolve) => {
      execFile(
        '/bin/ps',
        ['-p', String(pid), '-o', 'comm='],
        { timeout: 5_000 },
        (error, stdout) => {
          const path = String(stdout).trim()
          resolve(error || !path ? null : basename(path))
        }
      )
    }),
  kill: (pid) => process.kill(pid, 'SIGTERM'),
  alive: isAlive,
  sleep
}

const LETTER_IN_USE =
  'Cette lettre de lecteur est déjà utilisée. Choisissez-en une autre dans les réglages.'

/**
 * Proxy du système pour l'adresse du coffre (réglages, PAC, WPAD) : celui que Chromium
 * utilise pour l'API. rclone (Go) ne lit que HTTPS_PROXY : sans ceci, derrière un proxy
 * d'entreprise, l'appairage et l'API passaient mais le lecteur restait injoignable.
 * undefined : proxy inconnu, l'environnement hérité reste tel quel.
 */
async function systemProxyFor(url: string): Promise<string | null | undefined> {
  try {
    return rcloneProxy(parseProxyList(await session.defaultSession.resolveProxy(url)))
  } catch {
    return undefined
  }
}

/**
 * Sous-dossiers que rclone crée dans --cache-dir : données et métadonnées du cache. Seuls
 * ceux-là sont déplacés ou effacés — l'ancien dossier « cache » du profil est aussi, NTFS
 * ignorant la casse, le dossier « Cache » de Chromium (cache HTTP de l'application).
 */
const RCLONE_CACHE_PARTS = ['vfs', 'vfsMeta']

/**
 * Dossier du cache, créé au besoin. Windows : le cache des versions ≤ 3.2 (profil
 * itinérant) est déplacé une fois — il peut contenir des envois en attente, que rclone
 * reprend au montage suivant. Déplacement impossible (autre volume : AppData redirigé,
 * fichier tenu par un antivirus) : tout reste à l'ancien emplacement, ce qui avait déjà
 * bougé y revient — données et métadonnées ne doivent jamais être séparées (rclone
 * effacerait les unes sans les autres, envois en attente compris).
 */
async function prepareCacheDir(): Promise<string> {
  const cacheDir = rcloneCacheDir()
  mkdirSync(cacheDir, { recursive: true })
  const legacy = legacyRcloneCacheDir()
  if (!IS_WIN || legacy === cacheDir) return cacheDir
  const parts = RCLONE_CACHE_PARTS.filter(
    (part) => existsSync(join(legacy, part)) && !existsSync(join(cacheDir, part))
  )
  const moved: string[] = []
  for (const part of parts) {
    try {
      await renameWithRetry(join(legacy, part), join(cacheDir, part))
      moved.push(part)
    } catch (error) {
      for (const done of moved) {
        try {
          await renameWithRetry(join(cacheDir, done), join(legacy, done))
        } catch (back) {
          // Moitié ici, moitié là : le nouvel emplacement garde les données déplacées.
          log.error('cache de rclone partagé entre deux emplacements', back)
          return cacheDir
        }
      }
      log.warn('cache de rclone laissé dans le profil itinérant (déplacement impossible)', error)
      return legacy
    }
  }
  if (moved.length > 0) log.info(`cache de rclone déplacé dans le profil local : ${cacheDir}`)
  return cacheDir
}

/** Renommage, réessayé un instant : un antivirus tient parfois un fichier le temps d'un examen. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (attempt >= 3) throw error
      await sleep(300 * attempt)
    }
  }
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

/**
 * macOS : rclone lancé depuis une copie dans le profil, sans les attributs étendus du
 * paquet. Téléchargée par un navigateur, l'application porte l'attribut de quarantaine
 * jusque dans ses fichiers : un exécutable non signé ainsi marqué déclencherait l'alerte de
 * Gatekeeper (« le développeur ne peut pas être vérifié ») au lieu de monter le lecteur.
 * Copiée une fois par version (une copie en flux ne garde pas les attributs).
 */
async function macRcloneBinary(): Promise<string> {
  const source = getRclonePath()
  const dir = join(app.getPath('userData'), 'bin')
  const target = join(dir, 'rclone')
  const stampFile = join(dir, 'rclone.stamp')
  const stamp = `${app.getVersion()}:${(await stat(source)).size}`
  try {
    if (existsSync(target) && (await readFile(stampFile, 'utf8')) === stamp) return target
  } catch {
    // Pas encore de copie.
  }
  mkdirSync(dir, { recursive: true })
  const temporary = `${target}.tmp`
  await pipeline(createReadStream(source), createWriteStream(temporary, { mode: 0o755 }))
  await rename(temporary, target)
  await writeFile(stampFile, stamp)
  log.info(`rclone copié dans le profil (${stamp})`)
  return target
}

/**
 * Démonte un volume macOS. `force` : même occupé ou muet, directement par `umount -f`
 * (37 ms sur un volume NFS dont le serveur est mort, là où `diskutil unmount force`
 * attendait 8 s) ; sinon un démontage ordinaire, qui laisse un volume occupé en place.
 */
function unmountVolume(path: string, force: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/sbin/umount', force ? ['-f', path] : [path], { timeout: 10_000 }, (error) =>
      resolve(!error)
    )
  })
}

export class DriveMount {
  private proc: ChildProcess | null = null
  private rc: { port: number; user: string; pass: string } | null = null
  private mountedPath: string | null = null
  /** Comment le lecteur actuel est monté (null : pas monté). */
  private mountMethod: MountMethod | null = null
  /** Dossiers de premier niveau à la dernière lecture de la racine (null : pas encore lue). */
  private topFolders: string[] | null = null
  private logFile: string | null = null
  private logCheckedAt = 0
  /** Arrêt demandé (démontage) : la sortie de rclone qui suit n'est pas une panne. */
  private quitting = false
  /** Effacement de fichiers du système refusés en cours (un seul à la fois). */
  private discarding = false
  /** Fichiers du système déjà effacés (ou tentés) : chemin → heure. */
  private readonly discarded = new Map<string, number>()
  /**
   * Dossiers qui contiennent des envois en attente (et leurs parents, racine comprise) :
   * rclone y épingle sa liste (voir relistParams), à faire relire même pour « tout oublier ».
   */
  private pendingDirs = new Set<string>()

  /** Un seul assistant de notification de l'Explorateur pour toute la session (Windows). */
  private readonly notifier = new ShellNotifier({
    spawn: () =>
      spawn(
        systemTool('WindowsPowerShell\\v1.0\\powershell.exe'),
        helperArgs(getShellHelperPath()),
        { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }
      ),
    log: (message) => log.warn(message)
  })

  /** Monte le lecteur ; renvoie le chemin réellement monté. */
  async mount(request: MountRequest, onExit?: (code: number | null) => void): Promise<string> {
    await this.unmount()
    this.topFolders = null
    const started = Date.now()

    const path = IS_MAC
      ? await this.mountMac(request, onExit)
      : await this.mountRclone(request, onExit)
    log.info(`lecteur monté (${this.mountMethod}) sur ${path} en ${since(started)}`)
    return path
  }

  get path(): string | null {
    return this.mountedPath
  }

  get method(): MountMethod | null {
    return this.mountMethod
  }

  /**
   * Le lecteur répond-il ? Sans jamais toucher au volume (un `stat` sur un lecteur réseau
   * muet bloque un thread de Node) : le port de contrôle de rclone (délai de 5 s) et, sous
   * macOS, la présence du volume dans la table des montages.
   */
  async healthy(): Promise<boolean> {
    const path = this.mountedPath
    if (!path) return false
    if (this.mountMethod === 'webdav') return (await webdavMounted(path)) !== false
    if (!this.proc || this.proc.exitCode !== null || !this.rc) return false
    void this.maintainLog()
    try {
      await this.rcPost('core/pid', {}, HEALTH_TIMEOUT_MS)
    } catch {
      return false
    }
    // Volume éjecté du Finder, ou démonté d'office par macOS : à remonter.
    if (IS_MAC) return (await nfsMounted(path)) !== false
    return true
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
      const queued = (vfs.diskCache?.uploadsInProgress ?? 0) + (vfs.diskCache?.uploadsQueued ?? 0)
      // La file elle-même, seulement quand elle n'est pas vide : qui avance, qui est refusé.
      let queue = EMPTY_QUEUE
      if (queued > 0) {
        try {
          const items = (await this.rcPost<{ queue?: QueueItem[] }>('vfs/queue')).queue ?? []
          queue = summarizeQueue(items)
          this.pendingDirs = ancestorDirs(items.map((item) => item.name))
        } catch {
          queue = { ...EMPTY_QUEUE, active: queued, pending: queued }
        }
        if (queue.discard.length > 0) void this.discardSystemFiles(queue.discard)
      } else {
        this.pendingDirs = new Set()
      }
      return {
        transfers: (core.transferring ?? []).map((t) => ({
          name: t.name,
          bytes: t.bytes ?? 0,
          size: t.size ?? 0,
          percentage: t.percentage ?? 0,
          speed: t.speed ?? 0
        })),
        pendingUploads: queue.pending,
        activeUploads: queue.active,
        failing: queue.failing,
        completed: core.transfers ?? 0,
        errors: core.errors ?? 0,
        lastError: core.lastError || null
      }
    } catch {
      return NO_STATS
    }
  }

  /**
   * Des envois partent ou attendent leur premier essai (écriture différée). Un envoi refusé,
   * que rclone réessaiera dans quelques minutes, ne retient rien.
   */
  async busy(): Promise<boolean> {
    const stats = await this.stats()
    return stats.activeUploads > 0 || stats.transfers.length > 0
  }

  /**
   * Oubli de rclone : sous-arbres des dossiers touchés (dir=), et relecture des dossiers dont
   * le contenu a changé (file=, voir relistParams) — sans elle, un dossier qui contient un
   * envoi en attente (la racine, dès qu'un envoi attend quelque part) gardait sa liste
   * jusqu'à 10 min. « Tout oublier » : la racine et les dossiers des envois en attente.
   */
  private async forget(all: boolean, dirs: string[], changed: string[]): Promise<void> {
    if (all) {
      await this.rcPost('vfs/forget')
      await this.rcPost('vfs/forget', relistParams([...new Set(['', ...this.pendingDirs])]))
      return
    }
    await this.rcPost('vfs/forget', { ...forgetParams(dirs), ...relistParams(changed) })
  }

  /**
   * Fenêtres du Finder à relire (voir invalidate) : nouvelle date pour ces dossiers du
   * lecteur. Par un processus à part, avec un délai : le processus principal ne touche
   * jamais au volume. Un dossier disparu entre-temps est ignoré (-c : rien n'est créé).
   */
  private refreshFinder(root: string, dirs: string[]): Promise<void> {
    if (dirs.length === 0) return Promise.resolve()
    const paths = dirs.slice(0, FINDER_REFRESH_MAX).map((dir) => (dir ? join(root, dir) : root))
    return new Promise((resolve) =>
      execFile('/usr/bin/touch', ['-c', '--', ...paths], { timeout: 10_000 }, () => resolve())
    )
  }

  /** Dernière erreur d'envoi de chaque fichier, d'après la fin du journal de rclone. */
  async uploadErrors(): Promise<Map<string, string>> {
    if (!this.logFile) return new Map()
    return uploadErrors(await readLogTail(this.logFile).catch(() => ''))
  }

  /**
   * Fichiers du système (.DS_Store, « ._ »…) que le serveur refuse (droits, espace plein,
   * taille : la raison lue dans le journal de rclone) : effacés du lecteur, ce qui les retire
   * de la file de rclone (voir upload-queue). Un échec passager (coupure, serveur occupé)
   * n'efface rien : rclone réessaie. Par un processus à part sous macOS, avec un délai, un
   * par un sous Windows : le processus principal ne bloque jamais sur le volume.
   */
  private async discardSystemFiles(names: string[]): Promise<void> {
    const root = this.mountedPath
    if (!root || this.discarding) return
    this.discarding = true
    try {
      const now = Date.now()
      for (const [name, at] of this.discarded)
        if (now - at > DISCARD_RETRY_MS) this.discarded.delete(name)
      const errors = await this.uploadErrors()
      const refused = names
        .filter((name) => !this.discarded.has(name) && refusalReason(errors.get(name)) !== null)
        .slice(0, DISCARD_BATCH)
      if (refused.length === 0) return
      for (const name of refused) this.discarded.set(name, now)
      const paths = refused.map((name) =>
        IS_WIN
          ? mountPathForOpen(root) + name.split('/').map(explorerName).join('\\')
          : join(root, name)
      )
      let failed = 0
      if (IS_WIN) {
        for (const path of paths) {
          try {
            await rm(path, { force: true })
          } catch {
            failed += 1
          }
        }
      } else {
        failed = await new Promise<number>((resolve) =>
          execFile('/bin/rm', ['-f', '--', ...paths], { timeout: 10_000 }, (error) =>
            resolve(error ? paths.length : 0)
          )
        )
      }
      if (failed > 0) log.warn(`fichiers du système refusés : ${failed} non retirés du lecteur`)
      else
        log.info(`fichiers du système refusés par le serveur, retirés du lecteur : ${paths.length}`)
    } finally {
      this.discarding = false
    }
  }

  /**
   * Après un changement fait ailleurs (web, autre poste) : rclone oublie les dossiers
   * touchés (leur prochaine lecture repart du serveur), puis l'Explorateur est prévenu,
   * pour que son volet de navigation retire les dossiers disparus et montre les nouveaux.
   * « Tout oublier » relit la racine et fait relire chaque dossier de premier niveau.
   * macOS : le Finder, lui, ne relit une fenêtre ouverte que si la date du dossier change,
   * et ni rclone ni le serveur ne la changent quand le contenu bouge : chaque dossier oublié
   * reçoit une nouvelle date (`touch`, gardée en mémoire par rclone, rien n'est envoyé), et
   * le Finder le relit aussitôt (la racine seulement pour « tout oublier »).
   */
  async invalidate(plan: InvalidationPlan): Promise<void> {
    const path = this.mountedPath
    if (!path || !this.rc) return

    if (IS_MAC) {
      const dirs = [...plan.dirs, ...(plan.trash ? [TRASH_FOLDER] : [])]
      // Sans dossier nommé, « vfs/forget » oublierait tout : seulement si c'est demandé.
      if (!plan.all && dirs.length === 0) return
      const changed = plan.all
        ? ['']
        : [
            ...new Set([
              ...plan.shell.filter((change) => change.event === 'updatedir').map((c) => c.path),
              ...(plan.trash ? [TRASH_FOLDER] : [])
            ])
          ]
      try {
        await this.forget(plan.all, dirs, changed)
      } catch {
        // Port de contrôle injoignable : les listes se rafraîchiront d'elles-mêmes (10 min).
        return
      }
      await this.refreshFinder(path, changed)
      return
    }
    const root = mountPathForOpen(path)

    if (plan.all) {
      try {
        await this.forget(true, [], [''])
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
        await this.forget(
          false,
          dirs,
          shell.filter((change) => change.event === 'updatedir').map((change) => change.path)
        )
      } catch {
        // idem : le cache des dossiers expire de lui-même.
      }
    }
    this.notifier.notify(shell.map((change) => explorerChange(root, change)))
    this.trackTopFolders(shell)
  }

  /**
   * Dossiers de premier niveau apparus ou disparus : la prochaine relecture complète en
   * tient compte. Noms tels que l'Explorateur les voit (comme ceux lus sur le lecteur).
   */
  private trackTopFolders(shell: InvalidationPlan['shell']): void {
    if (!this.topFolders) return
    for (const change of shell) {
      if (!change.path || change.path.includes('/')) continue
      const name = explorerName(change.path)
      if (change.event === 'rmdir') this.topFolders = this.topFolders.filter((n) => n !== name)
      else if (change.event === 'mkdir' && !this.topFolders.includes(name))
        this.topFolders = [...this.topFolders, name]
    }
  }

  /**
   * Poste déconnecté : le cache est effacé — copies en clair des documents ouverts, et
   * envois restés en attente. Son sous-dossier dépend du token (rclone suffixe le nom du
   * remote d'une empreinte de sa configuration, token compris) : un nouvel appairage ne le
   * relirait jamais, il resterait sur le disque. Seulement une fois rclone arrêté.
   */
  async purgeCache(): Promise<PurgeResult> {
    const result: PurgeResult = { unsent: 0, rescued: 0, folder: null }
    if (this.proc) return result
    const roots = [...new Set([rcloneCacheDir(), legacyRcloneCacheDir()])]
    // Fichiers enregistrés mais pas encore envoyés : le cache seul les garde. Mis à l'abri
    // d'abord ; si l'un d'eux ne peut pas l'être, le cache reste (rien n'est perdu).
    const unsent = (await Promise.all(roots.map(findUnsent))).flat()
    if (unsent.length > 0) {
      result.unsent = unsent.length
      result.folder = join(app.getPath('documents'), RESCUE_FOLDER, rescueStamp(new Date()))
      result.rescued = await rescueUnsent(unsent, result.folder)
      log.warn(
        `déconnexion : ${result.rescued}/${unsent.length} fichier(s) non envoyé(s) mis de côté dans ${result.folder}`
      )
      if (result.rescued < unsent.length) {
        log.warn('cache gardé : des fichiers non envoyés n’ont pas pu être mis de côté')
        return result
      }
    }
    for (const root of roots) {
      for (const part of RCLONE_CACHE_PARTS) {
        const dir = join(root, part)
        try {
          await rm(dir, { recursive: true, force: true, maxRetries: 3 })
        } catch (error) {
          log.warn(`cache non effacé : ${dir}`, error)
        }
      }
    }
    return result
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

  /** Noms des dossiers à la racine du lecteur (null si le lecteur est illisible). Windows. */
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
    const method = this.mountMethod
    this.mountedPath = null
    this.mountMethod = null

    if (method === 'webdav') {
      // Un envoi du Finder peut être en cours : démontage ordinaire d'abord.
      if (path && !(await unmountVolume(path, false))) await unmountVolume(path, true)
      return
    }

    const proc = this.proc
    if (!proc) {
      if (IS_MAC && path) await this.ensureUnmounted(path)
      return
    }

    const deadline = waitForUploads ? Date.now() + UPLOAD_FLUSH_TIMEOUT_MS : 0
    // Seulement les envois qui avancent : un envoi refusé attendrait les 30 s pour rien (il
    // repartira au prochain montage, le cache le garde), une lecture en cours aussi.
    while (this.rc && Date.now() < deadline) {
      const { activeUploads } = await this.stats()
      if (activeUploads === 0) break
      await sleep(500)
    }

    this.quitting = true
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
    // rclone démonte en partant ; s'il ne l'a pas fait, le volume ne doit pas rester figé.
    if (IS_MAC && path) await this.ensureUnmounted(path)
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
        execFileSync('/sbin/umount', ['-f', this.mountedPath], { timeout: 5_000 })
      } catch {
        // déjà démonté
      }
    }
    this.proc = null
    this.rc = null
    this.mountedPath = null
    this.mountMethod = null
  }

  /**
   * rclone laissé par une session précédente (plantage, arrêt forcé) : arrêté avant de
   * remonter, sans bloquer le démarrage. Par son PID, noté à chaque montage ; sous Windows,
   * la première fois après la mise à jour (aucun PID encore noté), une recherche par chemin,
   * une fois. macOS : un volume resté monté sur le dossier du lecteur est démonté.
   */
  static async cleanupOrphans(mountPoint?: string): Promise<void> {
    const dir = app.getPath('userData')
    if (IS_MAC) {
      const outcome = await killRecordedOrphan(dir, macProcesses, 'rclone')
      if (outcome === 'killed') log.warn('rclone d’une session précédente arrêté')
      if (mountPoint && (await nfsMounted(mountPoint))) {
        log.warn(`volume resté monté démonté : ${mountPoint}`)
        await unmountVolume(mountPoint, true)
      }
      return
    }
    if (!IS_WIN) return
    const outcome = await killRecordedOrphan(dir, windowsProcesses)
    if (outcome === 'killed') log.warn('rclone d’une session précédente arrêté')
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

  /**
   * macOS : rclone (NFS) d'abord ; s'il est absent ou ne monte pas, le client WebDAV du
   * Finder. Un volume WebDAV du lecteur resté d'une version précédente est retiré avant.
   */
  private async mountMac(
    request: MountRequest,
    onExit?: (code: number | null) => void
  ): Promise<string> {
    const leftover = await findWebdavMount(request.finderUrl)
    if (leftover) {
      log.info(`ancien volume WebDAV démonté : ${leftover}`)
      await unmountVolume(leftover, false)
    }

    if (existsSync(getRclonePath())) {
      try {
        return await this.mountRclone(request, onExit)
      } catch (error) {
        // Refus du serveur (poste révoqué…) : le client WebDAV n'y changerait rien. Arrêt
        // demandé pendant le montage (fermeture de l'application) : pas de repli non plus,
        // osascript survivrait à l'application et laisserait un volume orphelin.
        if (this.quitting) throw error
        if (error instanceof UserFacingError && /refusé|relier|Reliez/i.test(error.message))
          throw error
        log.warn('montage rclone impossible, repli sur le client WebDAV du système', error)
      }
    } else {
      log.warn(`rclone absent (${getRclonePath()}) : client WebDAV du système`)
    }
    return this.mountMacWebdav(request)
  }

  /** Montage par rclone : WinFsp et une lettre (Windows), NFS et un dossier (macOS). */
  private async mountRclone(
    request: MountRequest,
    onExit?: (code: number | null) => void
  ): Promise<string> {
    if (!existsSync(getRclonePath())) {
      throw new UserFacingError('L’outil de montage est absent. Réinstallez Mapli Drive.')
    }
    const rclone = IS_MAC ? await macRcloneBinary() : getRclonePath()

    const dir = app.getPath('userData')
    const configFile = join(dir, 'rclone.conf')
    if (!existsSync(configFile)) writeFileSync(configFile, '')
    const cacheDir = await prepareCacheDir()
    const logFile = join(dir, 'rclone.log')
    this.logFile = logFile
    this.logCheckedAt = Date.now()
    try {
      await trimLog(logFile)
    } catch {
      // Journal verrouillé (rclone d'une session précédente ?) : il sera raccourci plus tard.
    }

    let mountPoint = request.mountPoint
    if (IS_MAC) {
      // Chemin réel (/tmp → /private/tmp, liens…) : celui de la table des montages, sans
      // quoi le volume prêt n'était jamais reconnu. Résolu par le dossier parent (local).
      const parent = dirname(mountPoint)
      await mkdir(parent, { recursive: true })
      mountPoint = join(await realpath(parent), basename(mountPoint))
      // Un montage resté là (plantage) est retiré avant de toucher au dossier : créer le
      // dossier d'un volume mort figerait le processus principal.
      if (await nfsMounted(mountPoint)) await unmountVolume(mountPoint, true)
      await mkdir(mountPoint, { recursive: true })
    }
    if (IS_WIN) {
      // Lettre prise par autre chose (clé USB, lecteur réseau, `subst`) : rclone échouerait,
      // et le contrôle de fin de montage croirait le lecteur prêt (« M:\ » répond). Un
      // lecteur qui vient d'être démonté peut mettre un instant à libérer sa lettre.
      const letter = mountPathForOpen(request.mountPoint)
      for (let waited = 0; ; waited += 250) {
        const state = await probePath(letter, 2_000)
        if (state === 'missing') break
        if (state === 'timeout' || waited >= 3_000) throw new UserFacingError(LETTER_IN_USE)
        await sleep(250)
      }
    }

    const rc = {
      port: await freePort(),
      user: randomBytes(12).toString('hex'),
      pass: randomBytes(24).toString('hex')
    }
    const options: MountOptions = {
      davUrl: request.davUrl,
      token: request.token,
      mountPoint,
      volumeName: VOLUME_NAME,
      rcPort: rc.port,
      rcUser: rc.user,
      rcPass: rc.pass,
      cacheDir,
      cacheSizeGb: request.cacheSizeGb,
      logFile,
      configFile,
      userAgent: `MapliDrive/${app.getVersion()}`,
      proxy: await systemProxyFor(request.davUrl)
    }
    if (options.proxy) log.info(`rclone passe par le proxy du système : ${options.proxy}`)

    this.quitting = false
    const proc = spawn(rclone, IS_MAC ? rcloneNfsMountArgs(options) : rcloneMountArgs(options), {
      env: rcloneMountEnv(options),
      windowsHide: true,
      stdio: 'ignore'
    })
    this.proc = proc
    this.rc = rc
    // rclone introuvable ou refusé (antivirus…) : un échec de montage, pas une exception.
    let spawnError: Error | null = null
    proc.once('error', (error) => {
      spawnError = error
      log.error('rclone ne démarre pas', error)
    })
    // Noté pour le nettoyage au prochain démarrage si l'application s'arrêtait brutalement.
    const pid = proc.pid
    if (pid) void recordPid(dir, pid)

    proc.on('exit', (code, signal) => {
      if (pid) void clearPid(dir, pid)
      if (this.proc !== proc) return
      const path = this.mountedPath
      const expected = this.quitting
      this.proc = null
      this.rc = null
      this.mountedPath = null
      this.mountMethod = null
      if (!expected)
        log.warn(`rclone s’est arrêté (code ${code ?? '–'}${signal ? `, signal ${signal}` : ''})`)
      // macOS : un volume NFS sans son serveur fige tout programme qui le touche — démonté
      // d'office, avant même de remonter.
      if (IS_MAC && path) void this.ensureUnmounted(path)
      // Arrêt demandé (pause, déconnexion, remontage) : rien à signaler, sinon le contrôleur
      // remonterait aussitôt le lecteur qu'on vient d'arrêter.
      if (!expected) onExit?.(code)
    })

    // Lecteur prêt ? Vérifié sans bloquer le processus principal : la table des montages
    // (macOS), le volume lui-même (Windows : le système de fichiers naissant peut tarder).
    const root = mountPathForOpen(mountPoint)
    const deadline = Date.now() + MOUNT_TIMEOUT_MS
    while (Date.now() < deadline && proc.exitCode === null && !spawnError) {
      await sleep(IS_MAC ? 250 : 400)
      if (proc.exitCode !== null || spawnError) break
      const ready = IS_MAC
        ? (await nfsMounted(mountPoint)) === true
        : (await probePath(root, 2_000)) === 'ok'
      if (ready) {
        this.mountedPath = mountPoint
        this.mountMethod = 'rclone'
        return mountPoint
      }
    }

    try {
      proc.kill()
    } catch {
      // déjà arrêté
    }
    this.proc = null
    this.rc = null
    if (IS_MAC) await this.ensureUnmounted(mountPoint)
    const explanation = await this.explainFailure(logFile)
    log.warn(`montage rclone en échec : ${explanation}`)
    throw new UserFacingError(explanation)
  }

  /** Démonte de force le volume s'il est encore là (macOS). */
  private async ensureUnmounted(path: string): Promise<void> {
    if ((await nfsMounted(path)) === false) return
    const done = await unmountVolume(path, true)
    if (!done) log.warn(`démontage impossible : ${path}`)
  }

  /** Message compréhensible à partir du journal de rclone (sa fin seulement). */
  private async explainFailure(logFile: string): Promise<string> {
    const log = (await readLogTail(logFile)).split('\n').slice(-40).join('\n')

    if (/winfsp|cgofuse/i.test(log))
      return 'Le composant WinFsp est manquant. Réinstallez Mapli Drive.'
    // Mot entier : « 401 » apparaît aussi dans des tailles, des ports ou des heures.
    if (/\b401\b|unauthori[sz]ed/i.test(log))
      return 'Mapli a refusé la connexion de ce poste. Reliez-le à nouveau.'
    if (/already in use|mountpoint .* exists|is already mounted/i.test(log))
      return IS_MAC
        ? 'Le dossier du lecteur est déjà utilisé. Redémarrez le Mac puis réessayez.'
        : LETTER_IN_USE
    if (/no such host|connection refused|timeout|i\/o timeout/i.test(log))
      return 'Mapli est injoignable. Vérifiez votre connexion internet.'

    return 'Le lecteur n’a pas pu être monté. Réessayez dans un instant.'
  }

  /**
   * Repli macOS : le volume par le Finder (client WebDAV du système). Un volume resté
   * monté et occupé est repris tel quel ; un montage que macOS termine juste après le
   * délai est repris aussi.
   */
  private async mountMacWebdav(request: MountRequest): Promise<string> {
    const leftover = await findWebdavMount(request.finderUrl)
    if (leftover) {
      log.info(`volume WebDAV déjà monté et occupé, repris : ${leftover}`)
      this.mountedPath = leftover
      this.mountMethod = 'webdav'
      return leftover
    }

    try {
      const path = await this.mountVolume(request)
      this.mountedPath = path
      this.mountMethod = 'webdav'
      return path
    } catch (error) {
      // macOS peut finir le montage juste après le délai, ou malgré une erreur d'osascript :
      // un volume présent est repris au lieu d'annoncer un échec.
      for (let attempt = 0; attempt < 10; attempt++) {
        const late = await findWebdavMount(request.finderUrl)
        if (late) {
          log.info(`montage WebDAV constaté malgré l’erreur, repris : ${late}`)
          this.mountedPath = late
          this.mountMethod = 'webdav'
          return late
        }
        await sleep(1_000)
      }
      throw error
    }
  }

  private mountVolume(request: MountRequest): Promise<string> {
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
        log.warn(`montage WebDAV : délai de ${MOUNT_TIMEOUT_MS / 1000} s dépassé`)
        reject(new UserFacingError('Le montage a pris trop de temps. Réessayez dans un instant.'))
      }, MOUNT_TIMEOUT_MS)

      proc.on('close', (code) => {
        clearTimeout(timer)
        const path = stdout.trim().replace(/\/+$/, '')
        if (code !== 0 || !path) {
          // Le token ne figure jamais au journal, même si osascript recopiait le script.
          const detail = stderr
            .split(request.token)
            .join('[token]')
            .replace(/with password "[^"]*"/g, 'with password "[masqué]"')
            .trim()
          log.warn(`montage WebDAV : échec (code ${code}) ${detail || 'sans message'}`)
          reject(
            new UserFacingError(
              /-128|annul/i.test(stderr)
                ? 'Montage annulé.'
                : 'Le lecteur n’a pas pu être monté. Réessayez dans un instant.'
            )
          )
          return
        }
        resolve(path)
      })

      proc.stdin.write(script)
      proc.stdin.end()
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
