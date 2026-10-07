import { join } from 'path'
import { app } from 'electron'

/*
 * Développement : un profil à part (MAPLI_DRIVE_PROFILE=<dossier>), pour ne jamais toucher à
 * celui de l'application installée (jeton du poste, réglages, cache, volume, journaux). Le
 * nom change aussi : le trousseau de macOS garde la clé de chiffrement sous ce nom, et
 * celle de l'application installée ne serait lisible qu'après une demande d'autorisation.
 * Importé juste après crash-dialog par index.ts : avant que session.ts n'ouvre son magasin.
 */
const profile = process.env.MAPLI_DRIVE_PROFILE
export const DEV_PROFILE = !app.isPackaged && Boolean(profile)

if (DEV_PROFILE && profile) {
  app.setName('Mapli Drive (développement)')
  app.setPath('userData', profile)
  app.setAppLogsPath(join(profile, 'logs'))
}

/**
 * Bancs et développement : un token d'appareil fourni (MAPLI_DRIVE_TOKEN) relie le poste
 * sans l'écran d'appairage. Seulement avec un profil de développement — jamais dans
 * l'application installée.
 */
export function devToken(): string | null {
  return DEV_PROFILE ? (process.env.MAPLI_DRIVE_TOKEN ?? null) : null
}
