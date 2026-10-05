/*
 * Adresses de Mapli. En développement, MAPLI_WEB_URL / MAPLI_API_URL pointent vers
 * l'environnement local (ex. http://localhost:3001 et http://localhost:8000/api/v1).
 */
export const WEB_URL = (process.env.MAPLI_WEB_URL ?? 'https://app.mapli.fr').replace(/\/$/, '')
export const API_URL = (process.env.MAPLI_API_URL ?? `${WEB_URL}/api/v1`).replace(/\/$/, '')

export const APP_ID = 'fr.mapli.drive'
export const PRODUCT_NAME = 'Mapli Drive'

/** Nom du volume affiché dans l'Explorateur. */
export const VOLUME_NAME = 'Mapli'
