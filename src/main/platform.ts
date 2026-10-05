import { join } from 'path'
import { existsSync } from 'fs'
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

export function isMountReady(mountPoint: string): boolean {
  return IS_WIN ? existsSync(`${mountPoint}\\`) : existsSync(mountPoint)
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
