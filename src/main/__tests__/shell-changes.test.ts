import { describe, expect, it } from 'vitest'
import { shellChangesFor } from '../shell-changes'

const ROOT = 'M:' + String.fromCharCode(92) // « M:\ »

describe('shellChangesFor', () => {
  it('annonce les dossiers disparus et apparus, puis fait relire la racine et chaque dossier', () => {
    expect(shellChangesFor(ROOT, ['Coucou', 'test', 'Clients'], ['Clients', 'Factures'])).toEqual([
      { event: 'rmdir', path: ROOT + 'Coucou' },
      { event: 'rmdir', path: ROOT + 'test' },
      { event: 'mkdir', path: ROOT + 'Factures' },
      { event: 'updatedir', path: ROOT },
      { event: 'updatedir', path: ROOT + 'Clients' },
      { event: 'updatedir', path: ROOT + 'Factures' }
    ])
  })

  it('sans liste précédente (nouveau montage), fait seulement relire', () => {
    expect(shellChangesFor(ROOT, null, [])).toEqual([{ event: 'updatedir', path: ROOT }])
  })
})
