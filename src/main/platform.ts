import { join } from 'path'
import { existsSync } from 'fs'
import { stat } from 'fs/promises'
import { app } from 'electron'

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
 * « timeout » (pas de réponse dans le délai).
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

/** Point de montage par défaut : « M: » (Mapli) s'il est libre, sinon la dernière lettre libre. */
export function defaultMountPoint(): string {
  if (!IS_WIN) return '/Volumes/Mapli'
  const free = availableDriveLetters()
  return free.includes('M:') ? 'M:' : (free[free.length - 1] ?? 'M:')
}
