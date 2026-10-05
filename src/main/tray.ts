import { Menu, Tray, app, nativeImage } from 'electron'
import type { DriveState } from '../shared/types'
import { PRODUCT_NAME } from './config'
import { getTrayIconPath, IS_MAC } from './platform'
import type { DriveController } from './controller'

/*
 * Icône de la zone de notification : le M de Mapli, avec une pastille d'état (vert
 * monté, orange en cours ou en pause, rouge hors ligne ou en erreur), et un menu court.
 * Les variantes sont des images (1× et 2×, nettes sur les écrans haute densité) ; sous
 * macOS, l'icône « Template » suit le thème de la barre des menus, sans pastille.
 */

const VARIANT: Record<string, 'ok' | 'busy' | 'error' | null> = {
  connected: 'ok',
  connecting: 'busy',
  pairing: 'busy',
  paused: 'busy',
  offline: 'error',
  error: 'error',
  unpaired: null
}

export function createTray(controller: DriveController, showWindow: () => void): Tray {
  const base = nativeImage.createFromPath(getTrayIconPath())
  const icons = new Map<string, Electron.NativeImage>()
  const iconFor = (phase: string): Electron.NativeImage => {
    const variant = VARIANT[phase] ?? null
    if (!variant || IS_MAC) return base
    if (!icons.has(variant))
      icons.set(variant, nativeImage.createFromPath(getTrayIconPath(variant)))
    return icons.get(variant)!
  }

  const tray = new Tray(base)
  tray.setToolTip(PRODUCT_NAME)

  const label = (state: DriveState): string => {
    switch (state.phase) {
      case 'connected':
        return state.transfers.length > 0
          ? `Envoi en cours (${state.transfers.length})`
          : `Lecteur ${state.mountPoint} · à jour`
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

  const refresh = (state: DriveState): void => {
    tray.setImage(iconFor(state.phase))
    tray.setToolTip(`${PRODUCT_NAME} — ${label(state)}`)

    tray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: state.device
            ? `${PRODUCT_NAME} · ${state.device.organization.name}`
            : PRODUCT_NAME,
          enabled: false
        },
        { label: label(state), enabled: false },
        { type: 'separator' },
        ...(state.phase === 'connected'
          ? [
              {
                label: `Ouvrir le lecteur ${state.mountPoint}`,
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
      ])
    )
  }

  refresh(controller.state)
  controller.on('state', refresh)
  tray.on('click', showWindow)
  tray.on('double-click', showWindow)

  return tray
}
