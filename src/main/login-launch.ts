import { execFile } from 'child_process'
import { userInfo } from 'os'
import { app } from 'electron'
import { IS_MAC, IS_WIN } from './platform'

/*
 * L'application a-t-elle été lancée par l'ouverture de session ? Elle reste alors dans la
 * barre des menus (macOS) ou la zone de notification (Windows), sans ouvrir sa fenêtre —
 * qui s'ouvrait jusqu'ici à chaque démarrage du poste :
 *  - Windows : l'entrée de démarrage passe l'argument LOGIN_ARG (Electron ne dit rien) ;
 *  - macOS 13 et suivants : `wasOpenedAtLogin` n'existe plus ; le lancement est comparé à
 *    l'ouverture de la session (démarrage du loginwindow de l'utilisateur) : moins de
 *    3 minutes après, c'est l'ouverture de session.
 */

export const LOGIN_ARG = '--opened-at-login'
const LOGIN_DELAY_MS = 3 * 60_000

/** Réglage de l'entrée de démarrage (avec l'argument sous Windows). */
export function loginItemSettings(openAtLogin: boolean): Electron.Settings {
  return IS_WIN ? { openAtLogin, args: [LOGIN_ARG] } : { openAtLogin }
}

/** Lancement automatique activé (sous Windows, l'entrée avec l'argument). */
export function opensAtLogin(): boolean {
  return IS_WIN
    ? app.getLoginItemSettings({ args: [LOGIN_ARG] }).openAtLogin
    : app.getLoginItemSettings().openAtLogin
}

/**
 * Windows : une entrée de démarrage d'avant (sans l'argument) est remplacée, pour que la
 * fenêtre ne s'ouvre plus à chaque démarrage. Rien à faire si le lancement est désactivé.
 * Désactivée dans le Gestionnaire des tâches, elle le reste : Electron l'active sinon par
 * défaut (enabled), et le choix de la personne serait perdu.
 */
export function migrateLoginItem(): void {
  if (!IS_WIN || !app.isPackaged) return
  const before = app.getLoginItemSettings()
  if (!before.openAtLogin || opensAtLogin()) return
  const old = before.launchItems?.find((item) => !item.args?.includes(LOGIN_ARG))
  const enabled = old?.enabled ?? before.executableWillLaunchAtLogin ?? true
  app.setLoginItemSettings({ openAtLogin: false })
  app.setLoginItemSettings({ ...loginItemSettings(true), enabled })
}

export async function openedAtLogin(): Promise<boolean> {
  if (IS_WIN) return process.argv.includes(LOGIN_ARG)
  if (!IS_MAC) return false
  const settings = app.getLoginItemSettings()
  if (settings.wasOpenedAtLogin) return true
  if (!settings.openAtLogin) return false
  const sessionAge = await loginSessionAgeMs()
  if (sessionAge === null) return false
  return sessionAge - process.uptime() * 1_000 < LOGIN_DELAY_MS
}

/** Âge de la session macOS (ms) : depuis le démarrage du loginwindow de l'utilisateur. */
function loginSessionAgeMs(): Promise<number | null> {
  const user = userInfo().username
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-axo', 'user=,etime=,comm='], { timeout: 3_000 }, (error, stdout) => {
      if (error) return resolve(null)
      resolve(sessionAgeFromPs(String(stdout), user))
    })
  })
}

/** Dans la sortie de `ps -axo user=,etime=,comm=`, l'âge du loginwindow de `user` (ms). */
export function sessionAgeFromPs(output: string, user: string): number | null {
  for (const line of output.split('\n')) {
    const [owner, etime, ...command] = line.trim().split(/\s+/)
    if (owner === user && /(^|\/)loginwindow$/.test(command.join(' '))) return parseEtime(etime)
  }
  return null
}

/** Durée « [[jj-]hh:]mm:ss » (colonne etime de ps) en millisecondes. */
export function parseEtime(etime: string | undefined): number | null {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime ?? '')
  if (!match) return null
  const [, days, hours, minutes, seconds] = match.map((part) => Number(part ?? 0))
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000
}
