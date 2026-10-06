import type {
  EmployeeSpaceNewFolder,
  EmployeeSpacePrompt,
  EmployeeSpaceState
} from '../shared/types'

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

/**
 * Nom provisoire que l'Explorateur ou le Finder donne à un dossier qu'on vient de créer, le
 * temps que la personne tape le sien (« Nouveau dossier », « dossier sans titre 2 »…) : rien
 * à proposer tant qu'il le porte.
 */
const PLACEHOLDER =
  /^(nouveau dossier|new folder|dossier sans titre|untitled folder|sans titre|untitled)(\s*\(\d+\)|\s+\d+)?$/i

export function isPlaceholderFolderName(name: string): boolean {
  return PLACEHOLDER.test(name.trim())
}

/** Un dossier proposable : nommé, et du même nom depuis assez longtemps (voir FolderNames). */
export type FolderReady = (folder: EmployeeSpaceNewFolder) => boolean

export function nextPrompt(
  space: EmployeeSpaceState | null,
  snoozed: ReadonlySet<string>,
  ready: FolderReady = (folder) => !isPlaceholderFolderName(folder.name)
): EmployeeSpacePrompt | null {
  if (!space) return null
  for (const group of space.groups) {
    const requests = group.requests.filter((r) => !snoozed.has(r.id))
    if (requests.length > 0) return { kind: 'publish', group: { ...group, requests } }
  }
  const folder = space.newFolders.find((f) => !snoozed.has(f.id) && ready(f))
  return folder ? { kind: 'folder', folder, seats: space.seats } : null
}

/** Ce qui attend en tout (menu de la zone de notification) ; pas les dossiers encore sans nom. */
export function pendingCount(space: EmployeeSpaceState | null): number {
  if (!space) return 0
  return (
    space.groups.reduce((n, g) => n + g.requests.length, 0) +
    space.newFolders.filter((f) => !isPlaceholderFolderName(f.name)).length
  )
}

/**
 * Le nom d'un nouveau dossier, stabilisé : la petite fenêtre ne propose un dossier qu'une fois
 * son nom tapé (pas « Nouveau dossier ») et inchangé depuis `settleMs` — le temps de le
 * corriger. Un nouveau nom relance l'attente.
 */
export class FolderNames {
  private readonly seen = new Map<string, { name: string; since: number }>()

  constructor(
    private readonly settleMs = 2_500,
    private readonly now: () => number = Date.now
  ) {}

  /** Relevé du serveur : retient depuis quand chaque dossier porte son nom actuel. */
  update(folders: readonly EmployeeSpaceNewFolder[]): void {
    const at = this.now()
    const alive = new Set<string>()
    for (const folder of folders) {
      alive.add(folder.id)
      const known = this.seen.get(folder.id)
      if (!known || known.name !== folder.name)
        this.seen.set(folder.id, { name: folder.name, since: at })
    }
    for (const id of [...this.seen.keys()]) if (!alive.has(id)) this.seen.delete(id)
  }

  readonly ready: FolderReady = (folder) => {
    if (isPlaceholderFolderName(folder.name)) return false
    const known = this.seen.get(folder.id)
    return !known || known.name !== folder.name || this.now() - known.since >= this.settleMs
  }

  /** Quand le prochain dossier nommé aura fini d'attendre (null : aucun n'attend). */
  nextReadyAt(): number | null {
    let next: number | null = null
    for (const { name, since } of this.seen.values()) {
      if (isPlaceholderFolderName(name)) continue
      const at = since + this.settleMs
      if (at > this.now() && (next === null || at < next)) next = at
    }
    return next
  }
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
