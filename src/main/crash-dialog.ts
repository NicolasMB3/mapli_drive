import { dialog } from 'electron'
import { PRODUCT_NAME } from './config'
import { log } from './log'

/*
 * Erreur imprévue du processus principal : Electron ouvrirait sa propre fenêtre, en
 * anglais et avec la pile d'appels (« A JavaScript error occurred in the main process »).
 * La même fenêtre, en français et sans jargon — une fois par quart d'heure au plus (une
 * erreur qui se répète dans une minuterie n'ouvre pas une fenêtre à chaque tour) ; le
 * détail part au journal. Une promesse rejetée sans traitement est seulement journalisée.
 * Importé en premier par index.ts, pour couvrir aussi le chargement des autres modules.
 */

const DIALOG_EVERY_MS = 15 * 60_000
let lastDialogAt = 0

const MESSAGE =
  'Une erreur inattendue est survenue. Si Mapli Drive ne fonctionne plus normalement, quittez-le, puis relancez-le.'

process.on('uncaughtException', (error) => {
  log.error('erreur inattendue', error)
  if (Date.now() - lastDialogAt < DIALOG_EVERY_MS) return
  lastDialogAt = Date.now()
  try {
    dialog.showErrorBox(PRODUCT_NAME, MESSAGE)
  } catch {
    // Fenêtre impossible (arrêt en cours) : le journal suffit.
  }
})

process.on('unhandledRejection', (reason) => {
  log.error('promesse rejetée sans traitement', reason)
})
