/*
 * Ce qu'un changement fait ailleurs (web, autre poste) doit faire oublier au lecteur, sans
 * Electron pour être testé. Le serveur annonce les dossiers touchés par leur identifiant ;
 * la table des dossiers (GET /desktop/app/drive/folders) donne leur chemin sur le lecteur.
 * Seuls ces dossiers sont oubliés par rclone (vfs/forget) et relus par l'Explorateur
 * (SHChangeNotify) ; tout oublier reste la réponse sûre quand on ne sait pas (« all »,
 * révision sautée, accès changés, table indisponible).
 */

/** Dossier de la corbeille, à la racine du lecteur des administrateurs. */
export const TRASH_FOLDER = 'Corbeille'
/** Au-delà, oublier tout coûte moins cher que d'énumérer. */
export const MAX_TARGETED_DIRS = 64

export interface FolderEntry {
  id: string
  path: string
}

/** Chemin relatif à la racine du lecteur, « / » pour séparateur, sans « / » au bord. */
export function normalizePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/')
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

/** Table identifiant → chemin des dossiers que la personne voit, avec son ETag. */
export class FolderMap {
  private byId = new Map<string, string>()
  etag: string | null = null
  loaded = false

  get size(): number {
    return this.byId.size
  }

  path(id: string): string | undefined {
    return this.byId.get(id)
  }

  /** Remplace la table ; renvoie les chemins disparus et apparus. */
  replace(entries: FolderEntry[], etag: string | null): { removed: string[]; added: string[] } {
    const next = new Map<string, string>()
    for (const entry of entries) {
      const path = normalizePath(entry.path)
      if (entry.id && path) next.set(entry.id, path)
    }
    const before = new Set(this.byId.values())
    const after = new Set(next.values())
    const diff = this.loaded
      ? {
          removed: [...before].filter((p) => !after.has(p)),
          added: [...after].filter((p) => !before.has(p))
        }
      : { removed: [], added: [] }
    this.byId = next
    this.etag = etag
    this.loaded = true
    return diff
  }

  clear(): void {
    this.byId.clear()
    this.etag = null
    this.loaded = false
  }
}

/** Événement drive.changed, lu sans confiance aveugle. */
export interface DriveChange {
  rev: string | null
  folders: string[] | 'all'
  tree: boolean
  trash: boolean
}

export function parseDriveChanged(data: unknown): DriveChange | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  const rev = typeof d.rev === 'string' || typeof d.rev === 'number' ? String(d.rev) : null
  const folders =
    d.folders === 'all'
      ? 'all'
      : Array.isArray(d.folders)
        ? d.folders.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : 'all'
  return { rev, folders, tree: d.tree === true, trash: d.trash === true }
}

/**
 * Révision reçue par rapport à la dernière vue. Révisions numériques : « next » (la
 * suivante), « skipped » (des changements ont échappé au poste, ou le compteur est
 * reparti de zéro), « same ». Sinon (empreintes) : « same » ou « changed ».
 */
export type RevisionStep = 'first' | 'same' | 'next' | 'skipped' | 'changed'

export function compareRevision(last: string | null, next: string | null): RevisionStep {
  if (next === null) return 'same'
  if (last === null) return 'first'
  if (last === next) return 'same'
  if (/^\d+$/.test(last) && /^\d+$/.test(next)) {
    const a = BigInt(last)
    const b = BigInt(next)
    return b === a + 1n ? 'next' : 'skipped'
  }
  return 'changed'
}

/** Notification du shell, chemin relatif à la racine du lecteur (« » : la racine). */
export interface RelativeShellChange {
  event: 'updatedir' | 'rmdir' | 'mkdir'
  path: string
}

export interface InvalidationPlan {
  /** Tout oublier (et relire la racine et ses dossiers dans l'Explorateur). */
  all: boolean
  /** Dossiers à oublier (rclone), chemins relatifs. */
  dirs: string[]
  /** La corbeille a changé (administrateurs). */
  trash: boolean
  /** Notifications pour l'Explorateur, dans l'ordre. */
  shell: RelativeShellChange[]
}

export function emptyPlan(): InvalidationPlan {
  return { all: false, dirs: [], trash: false, shell: [] }
}

export function forgetAllPlan(): InvalidationPlan {
  return { all: true, dirs: [], trash: false, shell: [] }
}

export function isEmptyPlan(plan: InvalidationPlan): boolean {
  return !plan.all && !plan.trash && plan.dirs.length === 0 && plan.shell.length === 0
}

export function mergePlans(a: InvalidationPlan, b: InvalidationPlan): InvalidationPlan {
  return {
    all: a.all || b.all,
    dirs: [...a.dirs, ...b.dirs],
    trash: a.trash || b.trash,
    shell: [...a.shell, ...b.shell]
  }
}

/** Dossiers connus de la table → à oublier et à faire relire ; les inconnus sont rendus à part. */
export function planForFolders(
  map: FolderMap,
  ids: string[]
): { plan: InvalidationPlan; unknown: string[] } {
  const plan = emptyPlan()
  const unknown: string[] = []
  for (const id of ids) {
    const path = map.path(id)
    if (path === undefined) {
      unknown.push(id)
      continue
    }
    plan.dirs.push(path)
    plan.shell.push({ event: 'updatedir', path })
  }
  return { plan, unknown }
}

/**
 * Arborescence changée (table relue) : dossiers disparus (RMDIR), apparus (MKDIR) — leur
 * parent est relu —, et les dossiers de l'événement qui n'étaient pas encore connus.
 */
export function planForTreeChange(
  diff: { removed: string[]; added: string[] },
  map: FolderMap,
  pendingIds: string[]
): InvalidationPlan {
  const plan = emptyPlan()
  for (const path of diff.removed) {
    plan.dirs.push(path)
    plan.shell.push({ event: 'rmdir', path }, { event: 'updatedir', path: parentPath(path) })
  }
  for (const path of diff.added) {
    plan.dirs.push(path)
    plan.shell.push({ event: 'mkdir', path }, { event: 'updatedir', path: parentPath(path) })
  }
  // Inconnus même après relecture : des dossiers que la personne ne voit pas, ignorés.
  const { plan: known } = planForFolders(map, pendingIds)
  return mergePlans(plan, known)
}

/**
 * Plan prêt à appliquer : doublons retirés, sous-dossiers d'un dossier déjà oublié retirés
 * (rclone oublie tout le sous-arbre), et « tout oublier » si la liste reste trop longue.
 */
export function finalizePlan(
  plan: InvalidationPlan,
  maxDirs: number = MAX_TARGETED_DIRS
): InvalidationPlan {
  if (plan.all) return forgetAllPlan()
  const unique = [...new Set(plan.dirs.map(normalizePath))].sort()
  const dirs: string[] = []
  for (const path of unique) {
    if (path === '') return forgetAllPlan()
    if (!dirs.some((kept) => path.startsWith(`${kept}/`))) dirs.push(path)
  }
  // Un dossier disparu ou apparu emporte ses sous-dossiers : une notification pour lui suffit.
  const moved = plan.shell
    .filter((change) => change.event !== 'updatedir')
    .map((change) => normalizePath(change.path))
  const seen = new Set<string>()
  const shell: RelativeShellChange[] = []
  for (const change of plan.shell) {
    const path = normalizePath(change.path)
    const key = `${change.event}:${path}`
    if (seen.has(key) || moved.some((m) => path.startsWith(`${m}/`))) continue
    seen.add(key)
    shell.push({ event: change.event, path })
  }
  if (dirs.length > maxDirs || shell.length > maxDirs * 3) return forgetAllPlan()
  return { all: false, dirs, trash: plan.trash, shell }
}

/** Paramètres de vfs/forget : dir, dir2, dir3… (une clé par dossier). */
export function forgetParams(dirs: string[]): Record<string, string> {
  const params: Record<string, string> = {}
  dirs.forEach((dir, index) => {
    params[index === 0 ? 'dir' : `dir${index + 1}`] = dir
  })
  return params
}
