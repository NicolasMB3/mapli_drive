import { describe, expect, it } from 'vitest'
import {
  compareRevision,
  finalizePlan,
  FolderMap,
  forgetParams,
  MAX_TARGETED_DIRS,
  mergePlans,
  normalizePath,
  parseDriveChanged,
  planForFolders,
  planForTreeChange,
  RELIST_MARKER,
  relistParams,
  emptyPlan
} from '../invalidation'

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function folderMap(entries: [number, string][]): FolderMap {
  const map = new FolderMap()
  map.replace(
    entries.map(([n, path]) => ({ id: id(n), path })),
    'W/"1"'
  )
  return map
}

describe('événement drive.changed', () => {
  it('se lit sans confiance aveugle', () => {
    expect(
      parseDriveChanged({ rev: 42, folders: [id(1), 3, ''], tree: true, trash: false })
    ).toEqual({ rev: '42', folders: [id(1)], tree: true, trash: false })
    expect(parseDriveChanged({ rev: '43', folders: 'all' })).toEqual({
      rev: '43',
      folders: 'all',
      tree: false,
      trash: false
    })
    // Liste absente ou illisible : tout oublier, c'est la réponse sûre.
    expect(parseDriveChanged({ rev: '44' })?.folders).toBe('all')
    expect(parseDriveChanged('nope')).toBeNull()
  })

  it('repère une révision sautée', () => {
    expect(compareRevision(null, '41')).toBe('first')
    expect(compareRevision('41', '41')).toBe('same')
    expect(compareRevision('41', '42')).toBe('next')
    expect(compareRevision('41', '44')).toBe('skipped')
    // Compteur reparti de zéro côté serveur : on ne sait pas ce qui a changé.
    expect(compareRevision('41', '3')).toBe('skipped')
    expect(compareRevision('41', null)).toBe('same')
    // Empreintes (serveur d'avant) : changée ou non, sans plus.
    expect(compareRevision('a1b2', 'c3d4')).toBe('changed')
  })
})

describe('dossiers annoncés → dossiers à oublier', () => {
  const map = folderMap([
    [1, 'Clients'],
    [2, 'Clients/Factures 2026'],
    [3, '/Espace salariés/Jean Dupont/'],
    [4, 'Chantier\\Grasse']
  ])

  it('situe les dossiers par leur chemin sur le lecteur', () => {
    const { plan, unknown } = planForFolders(map, [id(2), id(3), id(4)])
    expect(plan.dirs).toEqual([
      'Clients/Factures 2026',
      'Espace salariés/Jean Dupont',
      'Chantier/Grasse'
    ])
    expect(plan.shell).toEqual([
      { event: 'updatedir', path: 'Clients/Factures 2026' },
      { event: 'updatedir', path: 'Espace salariés/Jean Dupont' },
      { event: 'updatedir', path: 'Chantier/Grasse' }
    ])
    expect(unknown).toEqual([])
  })

  it('met à part les dossiers inconnus (que la personne ne voit pas)', () => {
    const { plan, unknown } = planForFolders(map, [id(1), id(99)])
    expect(plan.dirs).toEqual(['Clients'])
    expect(unknown).toEqual([id(99)])
  })

  it('arborescence changée : RMDIR des disparus, MKDIR des apparus, parents relus', () => {
    const tree = folderMap([
      [1, 'Clients'],
      [2, 'Clients/Factures'],
      [5, 'Archives']
    ])
    const diff = tree.replace(
      [
        { id: id(1), path: 'Clients' },
        { id: id(2), path: 'Clients/Factures 2026' },
        { id: id(6), path: 'Clients/Devis' }
      ],
      'W/"2"'
    )
    expect(diff).toEqual({
      removed: ['Clients/Factures', 'Archives'],
      added: ['Clients/Factures 2026', 'Clients/Devis']
    })
    const plan = finalizePlan(planForTreeChange(diff, tree, [id(6), id(77)]))
    expect(plan.all).toBe(false)
    expect(plan.dirs).toEqual([
      'Archives',
      'Clients/Devis',
      'Clients/Factures',
      'Clients/Factures 2026'
    ])
    expect(plan.shell).toEqual([
      { event: 'rmdir', path: 'Clients/Factures' },
      { event: 'updatedir', path: 'Clients' },
      { event: 'rmdir', path: 'Archives' },
      { event: 'updatedir', path: '' },
      { event: 'mkdir', path: 'Clients/Factures 2026' },
      { event: 'mkdir', path: 'Clients/Devis' },
      { event: 'updatedir', path: 'Clients/Devis' }
    ])
  })

  it('la première lecture de la table ne compte pas comme un changement d’arborescence', () => {
    const map = new FolderMap()
    expect(map.replace([{ id: id(1), path: 'Clients' }], null)).toEqual({ removed: [], added: [] })
    expect(map.loaded).toBe(true)
  })
})

describe('plan prêt à appliquer', () => {
  it('retire doublons et sous-dossiers d’un dossier déjà oublié', () => {
    const plan = finalizePlan({
      all: false,
      trash: false,
      dirs: ['Clients/Factures', 'Clients', 'Clients/', 'Clientèle', 'Archives/2025'],
      shell: [
        { event: 'updatedir', path: 'Clients' },
        { event: 'updatedir', path: 'Clients' }
      ]
    })
    // « Clientèle » n'est pas un sous-dossier de « Clients ».
    expect(plan.dirs).toEqual(['Archives/2025', 'Clients', 'Clientèle'])
    expect(plan.shell).toEqual([{ event: 'updatedir', path: 'Clients' }])
  })

  it('une seule notification pour un dossier disparu, pas pour son contenu', () => {
    const plan = finalizePlan({
      all: false,
      trash: false,
      dirs: ['Archives'],
      shell: [
        { event: 'rmdir', path: 'Archives' },
        { event: 'rmdir', path: 'Archives/2025' },
        { event: 'updatedir', path: 'Archives' },
        { event: 'updatedir', path: '' }
      ]
    })
    expect(plan.shell).toEqual([
      { event: 'rmdir', path: 'Archives' },
      { event: 'updatedir', path: 'Archives' },
      { event: 'updatedir', path: '' }
    ])
  })

  it('tout oublier dès que la liste est trop longue ou vise la racine', () => {
    const many = Array.from({ length: MAX_TARGETED_DIRS + 1 }, (_, i) => `Dossier ${i}`)
    expect(finalizePlan({ all: false, trash: false, dirs: many, shell: [] }).all).toBe(true)
    expect(finalizePlan({ all: false, trash: false, dirs: [''], shell: [] }).all).toBe(true)
    expect(finalizePlan(mergePlans(emptyPlan(), { ...emptyPlan(), all: true })).all).toBe(true)
  })

  it('corbeille : transmise telle quelle (les administrateurs l’oublient au montage)', () => {
    expect(finalizePlan({ ...emptyPlan(), trash: true }).trash).toBe(true)
  })

  it('paramètres de vfs/forget : une clé par dossier', () => {
    expect(forgetParams(['Clients', 'Archives/2025', 'Corbeille'])).toEqual({
      dir: 'Clients',
      dir2: 'Archives/2025',
      dir3: 'Corbeille'
    })
  })

  it('relecture des dossiers changés, racine comprise (file=<dossier>/<repère>, même épinglés)', () => {
    expect(relistParams(['', 'Clients/2026'])).toEqual({
      file: RELIST_MARKER,
      file2: `Clients/2026/${RELIST_MARKER}`
    })
    expect({ ...forgetParams(['Clients']), ...relistParams(['Clients']) }).toEqual({
      dir: 'Clients',
      file: `Clients/${RELIST_MARKER}`
    })
  })

  it('normalise les chemins', () => {
    expect(normalizePath('/Clients//Factures/')).toBe('Clients/Factures')
    expect(normalizePath('Clients\\Factures')).toBe('Clients/Factures')
    expect(normalizePath('./')).toBe('')
  })
})
