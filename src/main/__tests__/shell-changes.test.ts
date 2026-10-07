import { describe, expect, it } from 'vitest'
import { explorerChange, explorerName, MAX_SHELL_PATH, shellChangesFor } from '../shell-changes'

const ROOT = 'M:' + String.fromCharCode(92) // « M:\ »
const SEP = String.fromCharCode(92)

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

describe('chemins vus par l’Explorateur', () => {
  it('décale les caractères interdits sous Windows comme WinFsp (U+F000 + caractère)', () => {
    expect(explorerName('Réunion 12:30')).toBe('Réunion 12\uf03a30')
    expect(explorerName('Pourquoi ? "Devis" <A|B> *')).toBe(
      'Pourquoi \uf03f \uf022Devis\uf022 \uf03cA\uf07cB\uf03e \uf02a'
    )
    expect(explorerName('Comptabilité 2026 – été 📁')).toBe('Comptabilité 2026 – été 📁')
  })

  it('traduit un dossier du serveur en chemin du lecteur, la racine comprise', () => {
    expect(explorerChange(ROOT, { event: 'mkdir', path: 'Clients/Factures 12:30' })).toEqual({
      event: 'mkdir',
      path: `${ROOT}Clients${SEP}Factures 12\uf03a30`
    })
    expect(explorerChange(ROOT, { event: 'updatedir', path: '' })).toEqual({
      event: 'updatedir',
      path: ROOT
    })
  })

  it('trop long pour le shell : fait relire le plus proche parent qui tient', () => {
    const deep = ['Clients', 'A'.repeat(200), 'B'.repeat(100)].join('/')
    const change = explorerChange(ROOT, { event: 'rmdir', path: deep })
    expect(change).toEqual({ event: 'updatedir', path: `${ROOT}Clients${SEP}${'A'.repeat(200)}` })
    expect(change.path.length).toBeLessThanOrEqual(MAX_SHELL_PATH)
  })
})
