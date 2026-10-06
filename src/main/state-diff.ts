/*
 * L'état a-t-il vraiment changé ? Sans Electron, pour être testé : l'icône, son menu et
 * les fenêtres ne sont redessinés que si c'est le cas (un relevé des envois sans
 * nouveauté, une liste de fichiers récents identique ne déclenchent plus rien).
 */

export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
  // États de petite taille, construits toujours dans le même ordre : la comparaison du JSON suffit.
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Signature d'un menu : ce qui s'y voit (libellés, états, séparateurs), pas les actions. */
export function menuSignature(
  items: readonly { label?: string; enabled?: boolean; type?: string }[]
): string {
  return JSON.stringify(
    items.map((item) => [item.type ?? 'normal', item.label ?? '', item.enabled !== false])
  )
}

/** Clés de `partial` dont la valeur diffère de l'état courant. */
export function changedKeys<T extends object>(current: T, partial: Partial<T>): (keyof T)[] {
  return (Object.keys(partial) as (keyof T)[]).filter(
    (key) => !sameValue(current[key], partial[key])
  )
}
