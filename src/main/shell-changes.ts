/** Notification du shell Windows pour un dossier du lecteur (sans dépendance Electron : testée). */
export interface ShellChange {
  event: 'updatedir' | 'rmdir' | 'mkdir'
  path: string
}

/**
 * Au-delà, le shell ne sait pas désigner le dossier (MAX_PATH : 260 caractères, zéro final
 * compris) : la notification n'aurait aucun effet.
 */
export const MAX_SHELL_PATH = 259

/** Caractères interdits dans un nom Windows, en plus des caractères de contrôle. */
const RESERVED = new Set(['"', '*', ':', '<', '>', '?', '\\', '|'])

/**
 * Nom d'un fichier ou dossier du coffre tel que l'Explorateur le voit : WinFsp montre les
 * caractères interdits sous Windows (« : », « ? », « " »… permis sur le web et le Mac)
 * décalés dans la zone privée d'Unicode, U+F000 + caractère (src/shared/ku/posix.c de
 * WinFsp). Sans la même transposition, la notification visait un autre chemin
 * (« M:\Réunion 12:30 » se lit « M:\Réunion 12 », flux « 30 »).
 */
export function explorerName(name: string): string {
  let out = ''
  for (const c of name) {
    const code = c.charCodeAt(0)
    out += (code > 0 && code < 32) || RESERVED.has(c) ? String.fromCharCode(0xf000 | code) : c
  }
  return out
}

/**
 * Notification pour un dossier désigné comme le serveur (« Clients/Factures », « » pour la
 * racine) → chemin vu par l'Explorateur (« M:\Clients\Factures »). Un chemin trop long pour
 * le shell devient la relecture du plus proche parent qui tient dans la limite.
 */
export function explorerChange(
  root: string,
  change: { event: ShellChange['event']; path: string }
): ShellChange {
  const parts = change.path.split('/').filter(Boolean).map(explorerName)
  const join = (): string => root + parts.join('\\')
  if (join().length <= MAX_SHELL_PATH) return { event: change.event, path: join() }
  while (parts.length > 0 && join().length > MAX_SHELL_PATH) parts.pop()
  return { event: 'updatedir', path: join() }
}

/**
 * Notifications à envoyer après un changement fait ailleurs : dossiers de premier
 * niveau disparus (RMDIR) ou apparus (MKDIR), puis la racine et chaque dossier de
 * premier niveau à relire (UPDATEDIR). Sans liste précédente : relire seulement.
 * Les noms viennent de la lecture du lecteur : déjà tels que l'Explorateur les voit.
 */
export function shellChangesFor(
  root: string,
  previous: string[] | null,
  current: string[]
): ShellChange[] {
  const changes: ShellChange[] = []
  if (previous) {
    const before = new Set(previous)
    const now = new Set(current)
    for (const name of before)
      if (!now.has(name)) changes.push({ event: 'rmdir', path: root + name })
    for (const name of now)
      if (!before.has(name)) changes.push({ event: 'mkdir', path: root + name })
  }
  changes.push({ event: 'updatedir', path: root })
  for (const name of current) changes.push({ event: 'updatedir', path: root + name })
  return changes
}
