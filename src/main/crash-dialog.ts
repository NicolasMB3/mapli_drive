import { dialog } from 'electron'
import { PRODUCT_NAME } from './config'

/*
 * Erreur imprévue du processus principal : Electron ouvrirait sa propre fenêtre, en
 * anglais et avec la pile d'appels (« A JavaScript error occurred in the main process »).
 * La même fenêtre, en français et sans jargon ; le détail part dans la console. Importé
 * en premier par index.ts, pour couvrir aussi le chargement des autres modules.
 */

const MESSAGE =
  'Une erreur inattendue est survenue. Si Mapli Drive ne fonctionne plus normalement, quittez-le, puis relancez-le.'

process.on('uncaughtException', (error) => {
  console.error('[Mapli Drive] Erreur inattendue', error)
  try {
    dialog.showErrorBox(PRODUCT_NAME, MESSAGE)
  } catch {
    // Fenêtre impossible (arrêt en cours) : la console suffit.
  }
})
