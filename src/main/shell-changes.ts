/** Notification du shell Windows pour un dossier du lecteur (sans dépendance Electron : testée). */
export interface ShellChange {
  event: 'updatedir' | 'rmdir' | 'mkdir'
  path: string
}

/**
 * Notifications à envoyer après un changement fait ailleurs : dossiers de premier
 * niveau disparus (RMDIR) ou apparus (MKDIR), puis la racine et chaque dossier de
 * premier niveau à relire (UPDATEDIR). Sans liste précédente : relire seulement.
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
