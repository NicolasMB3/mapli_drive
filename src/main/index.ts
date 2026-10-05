import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import type { DriveSettings } from '../shared/types'
import {
  IPC_APP_INFO,
  IPC_DRIVE_CANCEL_PAIRING,
  IPC_DRIVE_DISMISS_NOTICE,
  IPC_DRIVE_OPEN,
  IPC_DRIVE_OPEN_VERIFICATION,
  IPC_DRIVE_OPEN_WEB,
  IPC_DRIVE_PAUSE,
  IPC_DRIVE_RESUME,
  IPC_DRIVE_START_PAIRING,
  IPC_DRIVE_STATE,
  IPC_DRIVE_STATE_CHANGED,
  IPC_DRIVE_UNPAIR,
  IPC_SETTINGS_GET,
  IPC_SETTINGS_MOUNT_POINTS,
  IPC_SETTINGS_SET,
  IPC_UPDATER_CHECK,
  IPC_UPDATER_INSTALL,
  IPC_UPDATER_STATUS,
  IPC_WINDOW_CLOSE,
  IPC_WINDOW_MINIMIZE
} from '../shared/ipc-channels'
import { APP_ID, WEB_URL } from './config'
import { DriveController } from './controller'
import { availableDriveLetters, getIconPath, IS_WIN } from './platform'
import { isFirstLaunch, markLaunched } from './session'
import { createTray } from './tray'
import { checkForUpdates, currentUpdateStatus, installUpdate, setupAutoUpdater } from './updater'

/*
 * Mapli Drive : l'application vit dans la zone de notification ; la fenêtre (créée à
 * la demande) affiche le lecteur, l'appairage et les réglages.
 */

const controller = new DriveController()
let mainWindow: BrowserWindow | null = null
// Fermer la fenêtre la cache ; seul « Quitter » (ou une mise à jour) quitte vraiment.
let quitting = false

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 660,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#FFFFFF',
    title: 'Mapli Drive',
    icon: getIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.once('ready-to-show', () => win.show())
  win.on('show', () => controller.setWindowVisible(true))
  win.on('hide', () => controller.setWindowVisible(false))
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
  })

  // Liens externes : navigateur du système, jamais dans la fenêtre de l'application.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  return win
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
  else {
    mainWindow.show()
    mainWindow.focus()
  }
}

// ── IPC ───────────────────────────────────────────────────

ipcMain.on(IPC_WINDOW_MINIMIZE, () => mainWindow?.minimize())
ipcMain.on(IPC_WINDOW_CLOSE, () => mainWindow?.hide())

ipcMain.handle(IPC_APP_INFO, () => ({
  version: app.getVersion(),
  platform: process.platform,
  webUrl: WEB_URL
}))

ipcMain.handle(IPC_DRIVE_STATE, () => controller.state)
ipcMain.handle(IPC_DRIVE_START_PAIRING, () => controller.startPairing())
ipcMain.handle(IPC_DRIVE_CANCEL_PAIRING, () => controller.cancelPairing())
ipcMain.handle(IPC_DRIVE_OPEN_VERIFICATION, () => controller.openVerification())
ipcMain.handle(IPC_DRIVE_OPEN, () => controller.openDrive())
ipcMain.handle(IPC_DRIVE_OPEN_WEB, (_event, page: unknown) => controller.openWeb(page))
ipcMain.handle(IPC_DRIVE_PAUSE, () => controller.pause())
ipcMain.handle(IPC_DRIVE_RESUME, () => controller.resume())
ipcMain.handle(IPC_DRIVE_UNPAIR, () => controller.unpair())
ipcMain.handle(IPC_DRIVE_DISMISS_NOTICE, () => controller.dismissNotice())

ipcMain.handle(IPC_SETTINGS_GET, () => ({
  ...controller.getSettings(),
  autoStart: app.getLoginItemSettings().openAtLogin
}))
ipcMain.handle(IPC_SETTINGS_SET, async (_event, next: Partial<DriveSettings>) => {
  if (typeof next.autoStart === 'boolean' && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: next.autoStart })
  }
  const settings = await controller.setSettings(next)
  return { ...settings, autoStart: app.getLoginItemSettings().openAtLogin }
})
ipcMain.handle(IPC_SETTINGS_MOUNT_POINTS, () =>
  availableDriveLetters(controller.getSettings().mountPoint)
)

ipcMain.handle(IPC_UPDATER_CHECK, () => checkForUpdates())
ipcMain.handle(IPC_UPDATER_STATUS, () => currentUpdateStatus())
ipcMain.handle(IPC_UPDATER_INSTALL, () => {
  quitting = true
  installUpdate()
})

controller.on('state', (state) => {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send(IPC_DRIVE_STATE_CHANGED, state)
})

// ── Cycle de vie ──────────────────────────────────────────

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(async () => {
    if (IS_WIN) app.setAppUserModelId(APP_ID)

    // Lancement au démarrage du poste, une fois, pour l'application installée.
    if (isFirstLaunch()) {
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true })
      markLaunched()
    }

    createTray(controller, showWindow)
    setupAutoUpdater(() => mainWindow)
    await controller.init()

    // Premier lancement ou poste non relié : on montre la fenêtre (appairage).
    if (controller.state.phase === 'unpaired' || !app.getLoginItemSettings().wasOpenedAtLogin)
      showWindow()
  })
}

// Quitter : on démonte proprement (envois en attente terminés), puis on sort.
app.on('before-quit', (event) => {
  if (quitting) {
    controller.killSync()
    return
  }
  event.preventDefault()
  quitting = true
  void controller.shutdown().finally(() => app.quit())
})

app.on('window-all-closed', () => {
  // L'application reste active dans la zone de notification.
})
