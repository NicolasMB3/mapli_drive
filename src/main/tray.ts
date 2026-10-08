import {
  Menu,
  Tray,
  app,
  nativeImage,
  nativeTheme,
  type MenuItemConstructorOptions
} from 'electron'
import { driveLabel } from '../shared/drive-label'
import type { DriveState } from '../shared/types'
import { PRODUCT_NAME } from './config'
import { pendingCount } from './employee-space'
import { getTrayIconPath, IS_MAC, type TrayState } from './platform'
import { menuSignature } from './state-diff'
import type { DriveController } from './controller'

/*
 * Icône de la zone de notification (Windows) et de la barre des menus (macOS), du kit de
 * marque 1.2 (17-mapli-drive) : pas de pastille qui morde le signe, l'état se lit dans le
 * trait — orange (à jour), qui balance d'une inclinaison à l'autre (en cours : 8 images de
 * 120 ms), dédoublé comme deux barres (en pause), tout le signe effacé (hors ligne), point
 * d'exclamation (erreur, rouge sous Windows). Windows : le jeu clair ou sombre selon la
 * barre des tâches, qui peut changer en cours de route ; macOS : images « modèles », que le
 * système teinte lui-même. Et un menu court.
 */

const IMAGES_EN_COURS = 8
const DUREE_IMAGE_MS = 120

/** L'état montré par l'icône. */
export function trayState(state: DriveState): TrayState {
  switch (state.phase) {
    case 'connected':
      if (state.notice) return 'erreur'
      return state.transfers.length > 0 || state.pendingUploads > 0 ? 'en-cours' : 'a-jour'
    case 'connecting':
    case 'pairing':
      return 'en-cours'
    case 'paused':
      return 'en-pause'
    case 'offline':
    case 'unpaired':
      return 'hors-ligne'
    case 'error':
      return 'erreur'
    default:
      return 'a-jour'
  }
}

export function createTray(
  controller: DriveController,
  showWindow: () => void,
  showEmployeeSpace: () => void
): Tray {
  // Images chargées une fois chacune (état, image de l'animation, thème de la barre des tâches).
  const images = new Map<string, Electron.NativeImage>()
  const imageOf = (etat: TrayState, image: number): Electron.NativeImage => {
    const dark = !IS_MAC && nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
    const key = `${etat}-${image}-${dark}`
    let img = images.get(key)
    if (!img) {
      img = nativeImage.createFromPath(getTrayIconPath(etat, image, dark))
      images.set(key, img)
    }
    return img
  }

  const tray = new Tray(imageOf(trayState(controller.state), 1))
  tray.setToolTip(PRODUCT_NAME)

  // L'état de l'icône, et l'animation « en cours » (seulement tant qu'elle dure).
  let etat = trayState(controller.state)
  let image = 1
  let animation: NodeJS.Timeout | null = null
  const montre = (): void => tray.setImage(imageOf(etat, image))
  const changeEtat = (suivant: TrayState): void => {
    if (suivant === etat) return
    etat = suivant
    image = 1
    if (animation) clearInterval(animation)
    animation = null
    montre()
    if (etat === 'en-cours') {
      animation = setInterval(() => {
        image = (image % IMAGES_EN_COURS) + 1
        montre()
      }, DUREE_IMAGE_MS)
      animation.unref()
    }
  }
  // Barre des tâches passée du clair au sombre (ou l'inverse) : l'autre jeu d'icônes.
  nativeTheme.on('updated', () => {
    if (!IS_MAC && !tray.isDestroyed()) montre()
  })

  const label = (state: DriveState): string => {
    switch (state.phase) {
      case 'connected':
        if (state.notice) return 'Envoi impossible · voir Mapli Drive'
        return state.transfers.length > 0
          ? `Envoi en cours (${state.transfers.length})`
          : `Lecteur ${driveLabel(state.mountPoint)} · à jour`
      case 'connecting':
        return 'Connexion du lecteur…'
      case 'pairing':
        return 'En attente de l’accord sur app.mapli.fr'
      case 'paused':
        return 'Lecteur en pause'
      case 'offline':
        return 'Hors ligne · reconnexion…'
      case 'error':
        return 'Action requise'
      default:
        return 'Poste non relié'
    }
  }

  // Ce qui est affiché : l'icône, son infobulle et son menu ne sont refaits que s'ils changent.
  const shown = { tooltip: '', menu: '' }

  const refresh = (state: DriveState): void => {
    changeEtat(trayState(state))
    const tooltip = `${PRODUCT_NAME} — ${label(state)}`
    if (tooltip !== shown.tooltip) {
      tray.setToolTip(tooltip)
      shown.tooltip = tooltip
    }
    // Espace salariés : ce qui attend une décision (documents à publier, dossiers à compléter).
    const waiting = pendingCount(state.employeeSpace)

    const template: MenuItemConstructorOptions[] = [
      {
        label: state.device ? `${PRODUCT_NAME} · ${state.device.organization.name}` : PRODUCT_NAME,
        enabled: false
      },
      { label: label(state), enabled: false },
      { type: 'separator' },
      ...(waiting > 0
        ? [
            { label: `Espace salariés · ${waiting} à valider`, click: showEmployeeSpace },
            { type: 'separator' as const }
          ]
        : []),
      ...(state.phase === 'connected'
        ? [
            {
              label: `Ouvrir le lecteur ${driveLabel(state.mountPoint)}`,
              click: () => controller.openDrive()
            }
          ]
        : []),
      { label: `Ouvrir ${PRODUCT_NAME}`, click: showWindow },
      ...(state.device
        ? [{ label: 'Coffre-fort sur le web', click: () => controller.openWeb() }]
        : []),
      ...(state.phase === 'connected'
        ? [
            { type: 'separator' as const },
            { label: 'Mettre en pause', click: () => void controller.pause() }
          ]
        : state.phase === 'paused' || state.phase === 'offline'
          ? [
              { type: 'separator' as const },
              { label: 'Reprendre', click: () => void controller.resume() }
            ]
          : []),
      { type: 'separator' },
      { label: 'Quitter', click: () => app.quit() }
    ]
    const menu = menuSignature(template)
    if (menu !== shown.menu) {
      tray.setContextMenu(Menu.buildFromTemplate(template))
      shown.menu = menu
    }
  }

  // État initial « en cours » : l'animation part tout de suite.
  if (etat === 'en-cours') {
    etat = 'a-jour'
    changeEtat('en-cours')
  }
  refresh(controller.state)
  controller.on('state', refresh)
  tray.on('click', showWindow)
  tray.on('double-click', showWindow)

  return tray
}
