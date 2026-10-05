import { autoUpdater } from 'electron-updater'
import { app, shell, type BrowserWindow } from 'electron'
import type { UpdateStatus } from '../shared/types'
import { IPC_UPDATER_STATUS } from '../shared/ipc-channels'
import { IS_MAC } from './platform'

/*
 * Mises à jour automatiques (GitHub Releases de mapli_drive). Sous Windows, la mise à
 * jour se télécharge seule puis s'installe au redémarrage choisi par l'utilisateur ;
 * sous macOS (application non signée), on ouvre la page de téléchargement.
 */

const RELEASES_URL = 'https://github.com/NicolasMB3/mapli_drive/releases/latest'
const INITIAL_CHECK_DELAY_MS = 10_000
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000

let status: { status: UpdateStatus; version?: string } = { status: 'idle' }
let getWindow: () => BrowserWindow | null = () => null

function publish(next: { status: UpdateStatus; version?: string }): void {
  status = next
  const win = getWindow()
  if (win && !win.isDestroyed()) win.webContents.send(IPC_UPDATER_STATUS, status)
}

export function currentUpdateStatus(): { status: UpdateStatus; version?: string } {
  return status
}

export function setupAutoUpdater(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter
  if (!app.isPackaged) return

  autoUpdater.autoDownload = !IS_MAC
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => publish({ status: 'checking' }))
  autoUpdater.on('update-available', (info) => publish({ status: IS_MAC ? 'available' : 'downloading', version: info.version }))
  autoUpdater.on('update-not-available', () => publish({ status: 'up-to-date' }))
  autoUpdater.on('update-downloaded', (info) => publish({ status: 'ready', version: info.version }))
  autoUpdater.on('error', () => publish({ status: 'error' }))

  const check = (): void => {
    autoUpdater.checkForUpdates().catch(() => publish({ status: 'error' }))
  }
  setTimeout(check, INITIAL_CHECK_DELAY_MS)
  setInterval(check, CHECK_INTERVAL_MS)
}

export function checkForUpdates(): void {
  if (!app.isPackaged) {
    publish({ status: 'up-to-date' })
    return
  }
  autoUpdater.checkForUpdates().catch(() => publish({ status: 'error' }))
}

/**
 * Installer la mise à jour téléchargée. L'appelant doit avoir levé le drapeau de sortie :
 * sinon la fenêtre, qui se cache au lieu de se fermer, bloquerait le redémarrage.
 */
export function installUpdate(): void {
  if (IS_MAC) {
    void shell.openExternal(RELEASES_URL)
    return
  }
  autoUpdater.quitAndInstall(false, true)
}
