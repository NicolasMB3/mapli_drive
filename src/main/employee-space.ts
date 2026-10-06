import type { EmployeeSpacePrompt, EmployeeSpaceState } from '../shared/types'

/*
 * Espace salariés : ce que la petite fenêtre propose, dans l'ordre — d'abord les documents
 * déposés dans le dossier d'un salarié (à publier dans son espace), salarié par salarié,
 * puis les dossiers créés à la main (« Nicolas BAAR » : créer son espace salarié ?). Ce
 * qui a été remis « à plus tard » n'est pas reproposé, jusqu'à ce qu'on rouvre la fenêtre.
 */

/** Identifiants qu'une proposition couvre (demandes, ou dossier). */
export function promptIds(prompt: EmployeeSpacePrompt): string[] {
  return prompt.kind === 'publish' ? prompt.group.requests.map((r) => r.id) : [prompt.folder.id]
}

/** Clé d'une proposition : la même qu'avant ne rouvre pas la fenêtre. */
export function promptKey(prompt: EmployeeSpacePrompt | null): string | null {
  return prompt ? `${prompt.kind}:${[...promptIds(prompt)].sort().join(',')}` : null
}

export function nextPrompt(
  space: EmployeeSpaceState | null,
  snoozed: ReadonlySet<string>
): EmployeeSpacePrompt | null {
  if (!space) return null
  for (const group of space.groups) {
    const requests = group.requests.filter((r) => !snoozed.has(r.id))
    if (requests.length > 0) return { kind: 'publish', group: { ...group, requests } }
  }
  const folder = space.newFolders.find((f) => !snoozed.has(f.id))
  return folder ? { kind: 'folder', folder, seats: space.seats } : null
}

/** Ce qui attend en tout (menu de la zone de notification). */
export function pendingCount(space: EmployeeSpaceState | null): number {
  if (!space) return 0
  return space.groups.reduce((n, g) => n + g.requests.length, 0) + space.newFolders.length
}

/** Oublie les reports d'éléments qui n'attendent plus (publiés, écartés, créés ailleurs). */
export function pruneSnoozed(space: EmployeeSpaceState, snoozed: Set<string>): void {
  const alive = new Set([
    ...space.groups.flatMap((g) => g.requests.map((r) => r.id)),
    ...space.newFolders.map((f) => f.id)
  ])
  for (const id of [...snoozed]) if (!alive.has(id)) snoozed.delete(id)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Identifiants venus de la fenêtre : des uuid, jamais autre chose (500 au plus). */
export function validIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((id): id is string => typeof id === 'string' && UUID.test(id)).slice(0, 500)
}

export function validId(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value : null
}
