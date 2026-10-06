// En premier : une erreur imprévue, même au chargement des modules, s'affiche en français.
import './crash-dialog'
import { app, BrowserWindow, ipcMain, screen, shell } from 'electron'
import { join } from 'path'
import type { DriveSettings, NewEmployeeInput } from '../shared/types'
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
  IPC_POPUP_RESIZE,
  IPC_SETTINGS_GET,
  IPC_SETTINGS_MOUNT_POINTS,
  IPC_SETTINGS_SET,
  IPC_SPACE_CREATE_EMPLOYEE,
  IPC_SPACE_DISCARD,
  IPC_SPACE_KEEP_FOLDER,
  IPC_SPACE_LATER,
  IPC_SPACE_OPEN_WEB,
  IPC_SPACE_PUBLISH,
  IPC_UPDATER_CHECK,
  IPC_UPDATER_INSTALL,
  IPC_UPDATER_STATUS,
  IPC_WINDOW_CLOSE,
  IPC_WINDOW_MINIMIZE
} from '../shared/ipc-channels'
import { APP_ID, WEB_URL } from './config'
import { DriveController } from './controller'
import { validId, validIds } from './employee-space'
import { availableDriveLetters, getIconPath, IS_WIN } from './platform'
import { isFirstLaunch, markLaunched } from './session'
import { createTray } from './tray'
import { checkForUpdates, currentUpdateStatus, installUpdate, setupAutoUpdater } from './updater'

/*
 * Mapli Drive : l'application vit dans la zone de notification ; la fenêtre (créée à
 * la demande) affiche le lecteur, l'appairage et les réglages.
 */

// Chromium en français (textes natifs, langue annoncée au réseau), comme le reste de
// l'application, quelle que soit la langue du système. À poser avant « ready ».
app.commandLine.appendSwitch('lang', 'fr')

const controller = new DriveController()
let mainWindow: BrowserWindow | null = null
// Fermer la fenêtre la cache ; seul « Quitter » (ou une mise à jour) quitte vraiment.
let quitting = false

/** Une fenêtre cachée depuis 5 min est détruite (60 à 90 Mo rendus) ; recréée à la demande. */
const DESTROY_HIDDEN_AFTER_MS = 5 * 60_000

/** L'état n'est envoyé qu'aux fenêtres visibles ; une fenêtre qui réapparaît le reçoit aussitôt. */
function sendState(win: BrowserWindow | null): void {
  if (win && !win.isDestroyed()) win.webContents.send(IPC_DRIVE_STATE_CHANGED, controller.state)
}

function destroyWhenHidden(win: BrowserWindow, onDestroyed: () => void): void {
  let timer: NodeJS.Timeout | null = null
  const cancel = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const arm = (): void => {
    cancel()
    timer = setTimeout(() => {
      timer = null
      if (!win.isDestroyed() && !win.isVisible()) win.destroy()
    }, DESTROY_HIDDEN_AFTER_MS)
  }
  // Armé dès la création : une fenêtre jamais montrée (proposition retirée entre-temps) part aussi.
  arm()
  win.on('hide', arm)
  win.on('show', cancel)
  win.on('closed', () => {
    cancel()
    onDestroyed()
  })
}

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
  win.on('show', () => {
    sendState(win)
    controller.setWindowVisible(true)
  })
  win.on('restore', () => sendState(win))
  win.on('hide', () => controller.setWindowVisible(false))
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
  })
  destroyWhenHidden(win, () => {
    if (mainWindow === win) mainWindow = null
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
    // L'état d'abord : la fenêtre ne montre pas, même un instant, celui d'avant.
    sendState(mainWindow)
    mainWindow.show()
    mainWindow.focus()
  }
}

// ── Petite fenêtre de l'espace salariés (en bas à droite) ─────────

/*
 * Après un dépôt dans M:\Espace salariés\<salarié>\<catégorie> : « Publier dans son
 * espace ? » ; après la création d'un dossier dans M:\Espace salariés : « Créer son espace
 * salarié ? ». Toujours au premier plan, sans voler le focus ; elle s'ajuste à son contenu.
 */
const POPUP_WIDTH = 360
const POPUP_MARGIN = 16
let popupWindow: BrowserWindow | null = null
let popupHeight = 300

function placePopup(win: BrowserWindow): void {
  const area = screen.getPrimaryDisplay().workArea
  win.setBounds({
    x: area.x + area.width - POPUP_WIDTH - POPUP_MARGIN,
    y: area.y + area.height - popupHeight - POPUP_MARGIN,
    width: POPUP_WIDTH,
    height: popupHeight
  })
}

function createPopupWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: POPUP_WIDTH,
    height: popupHeight,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
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
  win.setAlwaysOnTop(true, 'pop-up-menu')

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#popup`)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'popup' })
  }

  win.once('ready-to-show', () => {
    placePopup(win)
    if (controller.state.prompt) win.showInactive()
  })
  win.on('show', () => sendState(win))
  win.on('close', (event) => {
    // Fermer = « Plus tard » ; la fenêtre reste prête pour la prochaine proposition.
    if (quitting) return
    event.preventDefault()
    controller.laterEmployeeSpace()
  })
  // Recréée en moins d'une seconde à la prochaine proposition.
  destroyWhenHidden(win, () => {
    if (popupWindow === win) popupWindow = null
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    controller.openSpaceWeb(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  return win
}

function showPopup(): void {
  if (!popupWindow || popupWindow.isDestroyed()) {
    popupWindow = createPopupWindow()
    return
  }
  sendState(popupWindow)
  placePopup(popupWindow)
  popupWindow.showInactive()
}

controller.on('prompt', showPopup)
controller.on('prompt-done', () => {
  if (popupWindow && !popupWindow.isDestroyed()) popupWindow.hide()
})

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

ipcMain.handle(IPC_SPACE_PUBLISH, (_event, ids: unknown, notify: unknown) =>
  controller.publishEmployeeSpace(validIds(ids), notify === true)
)
ipcMain.handle(IPC_SPACE_DISCARD, (_event, ids: unknown) =>
  controller.discardEmployeeSpace(validIds(ids))
)
ipcMain.handle(IPC_SPACE_CREATE_EMPLOYEE, (_event, folderId: unknown, input: unknown) => {
  const id = validId(folderId)
  const fields = newEmployeeInput(input)
  if (!id || !fields) return { ok: false, message: 'Fiche incomplète : prénom, nom et e-mail.' }
  return controller.createEmployeeFromFolder(id, fields)
})
ipcMain.handle(IPC_SPACE_KEEP_FOLDER, (_event, folderId: unknown) => {
  const id = validId(folderId)
  return id ? controller.keepEmployeeFolder(id) : { ok: false, message: 'Dossier introuvable.' }
})
ipcMain.handle(IPC_SPACE_LATER, () => controller.laterEmployeeSpace())
ipcMain.handle(IPC_SPACE_OPEN_WEB, (_event, url: unknown) => controller.openSpaceWeb(url))
ipcMain.on(IPC_POPUP_RESIZE, (_event, height: unknown) => {
  if (typeof height !== 'number' || !Number.isFinite(height)) return
  popupHeight = Math.min(Math.max(Math.round(height), 160), 720)
  if (popupWindow && !popupWindow.isDestroyed()) placePopup(popupWindow)
})

/** La fiche envoyée par la fenêtre : des chaînes, bornées ; rien d'autre ne passe. */
function newEmployeeInput(value: unknown): NewEmployeeInput | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const text = (key: string, max: number): string =>
    typeof v[key] === 'string' ? (v[key] as string).trim().slice(0, max) : ''
  const first = text('first_name', 255)
  const last = text('last_name', 255)
  const email = text('email', 255)
  if (!first || !last || !email) return null
  const phone = text('phone', 20)
  const address =
    v.address && typeof v.address === 'object' ? (v.address as Record<string, unknown>) : null
  const line1 = typeof address?.line1 === 'string' ? address.line1.trim().slice(0, 45) : ''
  const postal =
    typeof address?.postal_code === 'string' ? address.postal_code.trim().slice(0, 5) : ''
  const city = typeof address?.city === 'string' ? address.city.trim().slice(0, 255) : ''
  return {
    first_name: first,
    last_name: last,
    email,
    ...(phone ? { phone } : {}),
    ...(line1 && postal && city ? { address: { line1, postal_code: postal, city } } : {})
  }
}

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

// Fenêtres cachées : rien n'est envoyé (elles reçoivent l'état en réapparaissant).
controller.on('state', () => {
  for (const win of [mainWindow, popupWindow]) {
    if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) sendState(win)
  }
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

    createTray(controller, showWindow, () => controller.showEmployeeSpace())
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
