import { describe, expect, it } from 'vitest'
import type { EmployeeSpaceState } from '../../shared/types'
import {
  FolderNames,
  isPlaceholderFolderName,
  nextPrompt,
  pendingCount,
  promptKey,
  pruneSnoozed,
  validId,
  validIds
} from '../employee-space'

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const request = (n: number) => ({
  id: id(n),
  document_id: id(100 + n),
  name: `doc-${n}.pdf`,
  size_bytes: 10,
  created_at: ''
})

const space: EmployeeSpaceState = {
  groups: [
    {
      employee: { id: 'e1', name: 'Jean Dupont', email: 'j@x.fr', status: 'active' },
      category: null,
      folder_id: null,
      web_url: '',
      requests: [request(1), request(2)],
      requested_at: null
    },
    {
      employee: { id: 'e2', name: 'Marie Martin', email: 'm@x.fr', status: 'active' },
      category: null,
      folder_id: null,
      web_url: '',
      requests: [request(3)],
      requested_at: null
    }
  ],
  newFolders: [
    {
      id: id(9),
      name: 'Nicolas BAAR',
      suggested: { first_name: 'Nicolas', last_name: 'BAAR' },
      created_at: null,
      web_url: ''
    }
  ],
  seats: { used: 1, limit: 40, remaining: 39, can_create: true }
}

describe('petite fenêtre de l’espace salariés', () => {
  it('propose d’abord les documents à publier, salarié par salarié, puis les dossiers à compléter', () => {
    const first = nextPrompt(space, new Set())
    expect(first?.kind).toBe('publish')
    expect(first?.kind === 'publish' && first.group.employee?.name).toBe('Jean Dupont')

    const afterJean = nextPrompt(space, new Set([id(1), id(2)]))
    expect(afterJean?.kind === 'publish' && afterJean.group.employee?.name).toBe('Marie Martin')

    const afterAll = nextPrompt(space, new Set([id(1), id(2), id(3)]))
    expect(afterAll?.kind).toBe('folder')
    expect(nextPrompt(space, new Set([id(1), id(2), id(3), id(9)]))).toBeNull()
  })

  it('ne reprend dans une proposition que ce qui n’a pas été remis à plus tard', () => {
    const prompt = nextPrompt(space, new Set([id(1)]))
    expect(prompt?.kind === 'publish' && prompt.group.requests.map((r) => r.id)).toEqual([id(2)])
    expect(promptKey(prompt)).toBe(`publish:${id(2)}`)
  })

  it('compte ce qui attend et oublie les reports d’éléments disparus', () => {
    expect(pendingCount(space)).toBe(4)
    expect(pendingCount(null)).toBe(0)
    const snoozed = new Set([id(1), id(42)])
    pruneSnoozed(space, snoozed)
    expect([...snoozed]).toEqual([id(1)])
  })

  it('n’accepte de la fenêtre que des identifiants', () => {
    expect(validIds([id(1), 'x; rm -rf', 3, id(2)])).toEqual([id(1), id(2)])
    expect(validIds('nope')).toEqual([])
    expect(validId(id(1))).toBe(id(1))
    expect(validId('../dossier')).toBeNull()
  })
})

describe('nouveaux dossiers : proposés une fois nommés', () => {
  const folder = (n: number, name: string) => ({
    id: id(500 + n),
    name,
    suggested: { first_name: name.split(' ')[0] ?? '', last_name: name.split(' ')[1] ?? '' },
    created_at: '',
    web_url: ''
  })
  const withFolders = (...folders: ReturnType<typeof folder>[]): EmployeeSpaceState => ({
    groups: [],
    newFolders: folders,
    seats: null
  })

  it('ne propose pas un dossier qui porte encore son nom provisoire', () => {
    for (const name of ['Nouveau dossier', 'Nouveau dossier (2)', 'New folder', 'dossier sans titre 3', 'Untitled Folder']) {
      expect(isPlaceholderFolderName(name)).toBe(true)
      expect(nextPrompt(withFolders(folder(1, name)), new Set())).toBeNull()
    }
    expect(isPlaceholderFolderName('Nicolas BAAR')).toBe(false)
    expect(isPlaceholderFolderName('Nouveau dossier Dupont')).toBe(false)
    expect(pendingCount(withFolders(folder(1, 'Nouveau dossier'), folder(2, 'Marie Martin')))).toBe(1)
  })

  it('attend que le nom tapé soit posé, et relance l’attente à chaque nouveau nom', () => {
    let now = 1_000
    const names = new FolderNames(2_500, () => now)
    const space = withFolders(folder(1, 'Nouveau dossier'))
    names.update(space.newFolders)
    expect(nextPrompt(space, new Set(), names.ready)).toBeNull()
    expect(names.nextReadyAt()).toBeNull()

    // Renommé : proposé 2,5 s plus tard seulement.
    const renamed = withFolders(folder(1, 'Un compte'))
    now = 2_000
    names.update(renamed.newFolders)
    expect(nextPrompt(renamed, new Set(), names.ready)).toBeNull()
    expect(names.nextReadyAt()).toBe(4_500)

    // Corrigé avant la fin de l'attente : l'attente repart.
    const fixed = withFolders(folder(1, 'Camille Portail'))
    now = 3_000
    names.update(fixed.newFolders)
    now = 5_000
    expect(nextPrompt(fixed, new Set(), names.ready)).toBeNull()
    now = 5_600
    expect(nextPrompt(fixed, new Set(), names.ready)?.kind).toBe('folder')
    expect(names.nextReadyAt()).toBeNull()
  })

  it('propose aussitôt un dossier arrivé déjà nommé et jamais vu (copié, glissé)', () => {
    const names = new FolderNames(2_500, () => 10_000)
    const space = withFolders(folder(1, 'Marie Martin'))
    // Jamais relevé : rien ne dit qu'il vient d'être renommé.
    expect(nextPrompt(space, new Set(), names.ready)?.kind).toBe('folder')
  })
})
