import { basename, join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { stat } from 'fs/promises'
import { app } from 'electron'
import { APP_ID, VOLUME_NAME } from './config'
import { DEV_PROFILE } from './dev-profile'

export const IS_WIN = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'

function resource(name: string): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'resources', name)
    : join(__dirname, '../../resources', name)
}

export function getRclonePath(): string {
  return resource(IS_WIN ? 'rclone.exe' : 'rclone')
}

export function getIconPath(): string {
  return resource(IS_WIN ? 'icon.ico' : 'icon.png')
}

/** Icône de la zone de notification ; `variant` = pastille d'état (Windows). */
export function getTrayIconPath(variant?: 'ok' | 'busy' | 'error'): string {
  if (IS_MAC) return resource('tray-iconTemplate.png')
  return resource(variant ? `tray-${variant}.png` : 'tray-icon.png')
}

/** Assistant de notification de l'Explorateur (script PowerShell livré avec l'application). */
export function getShellHelperPath(): string {
  return resource('explorer-notify.ps1')
}

/** Outil de Windows par son chemin complet (jamais cherché dans le PATH ni le dossier courant). */
export function systemTool(relative: string): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', relative)
}

/**
 * Le chemin répond-il ? Sans bloquer le processus principal (un lecteur réseau figé peut
 * faire attendre un appel synchrone plusieurs secondes) : « ok », « missing » (absent) ou
 * « timeout » (pas de réponse dans le délai). ⚠️ Le délai rend la main, pas le thread : un
 * `stat` sur un lecteur muet occupe un thread du pool de Node jusqu'à sa réponse (4 en
 * tout : fichiers, DNS, chiffrement). Jamais de vérification périodique par ce moyen sur
 * un volume réseau — la table des montages (mac-mounts.ts) ou le port de rclone suffisent.
 */
export function probePath(path: string, timeoutMs: number): Promise<'ok' | 'missing' | 'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs)
    stat(path).then(
      () => {
        clearTimeout(timer)
        resolve('ok')
      },
      () => {
        clearTimeout(timer)
        resolve('missing')
      }
    )
  })
}

export function mountPathForOpen(mountPoint: string): string {
  return IS_WIN ? `${mountPoint}\\` : mountPoint
}

/** Lettres de lecteur libres (Windows), de D: à Z:. */
export function availableDriveLetters(current?: string): string[] {
  if (!IS_WIN) return []
  return 'DEFGHIJKLMNOPQRSTUVWXYZ'
    .split('')
    .map((l) => `${l}:`)
    .filter((letter) => letter === current || !existsSync(`${letter}\\`))
}

/**
 * Point de montage par défaut : « M: » (Mapli) s'il est libre, sinon la dernière lettre
 * libre. macOS : un dossier « Mapli » du profil de l'application (rclone monte sans droits
 * d'administrateur, /Volumes leur est réservé) ; le Finder affiche le volume sous ce nom,
 * dans « Emplacements ».
 */
export function defaultMountPoint(): string {
  if (IS_MAC) return join(app.getPath('userData'), VOLUME_NAME)
  if (!IS_WIN) return '/Volumes/Mapli'
  const free = availableDriveLetters()
  return free.includes('M:') ? 'M:' : (free[free.length - 1] ?? 'M:')
}

/**
 * Cache local des fichiers ouverts. macOS : ~/Library/Caches (jamais sauvegardé par Time
 * Machine, contrairement au profil de l'application) ; Windows : %LOCALAPPDATA%, le profil
 * local — jamais itinérant ni redirigé vers un partage réseau (stratégies d'entreprise),
 * alors que le cache peut peser 10 Go et que rclone veut un disque à fichiers creux.
 */
export function rcloneCacheDir(): string {
  // Profil de développement : son propre cache — jamais celui de l'application installée
  // (deux rclone sur un même cache, ou une déconnexion de test qui l'effacerait).
  if (DEV_PROFILE) return join(app.getPath('userData'), 'rclone-cache')
  if (IS_MAC) return join(homedir(), 'Library', 'Caches', APP_ID, 'rclone')
  const local = process.env.LOCALAPPDATA
  return local ? join(local, basename(app.getPath('userData')), 'cache') : legacyRcloneCacheDir()
}

/** Emplacement du cache des versions ≤ 3.2 (Windows) : le profil itinérant (%APPDATA%). */
export function legacyRcloneCacheDir(): string {
  return join(app.getPath('userData'), 'cache')
}
