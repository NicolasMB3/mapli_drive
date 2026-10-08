import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { findUnsent, rescueNotice, rescueStamp, rescueUnsent } from '../cache-rescue'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Nom du remote dans le cache : « :webdav{…} », deux-points écrit « ： » sous Windows (il y
 * est interdit dans un nom de fichier ; rclone le remplace ainsi).
 */
const REMOTE = process.platform === 'win32' ? '\uff1awebdav{AbCdE}' : ':webdav{AbCdE}'

/** Un cache de rclone : métadonnées (Dirty ou non) et contenu, sous un remote suffixé. */
function cache(items: { path: string; dirty: boolean; content?: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'mapli-cache-'))
  roots.push(root)
  for (const item of items) {
    const meta = join(root, 'vfsMeta', REMOTE, ...item.path.split('/'))
    mkdirSync(dirname(meta), { recursive: true })
    writeFileSync(meta, JSON.stringify({ Size: 3, Dirty: item.dirty }))
    if (item.content !== undefined) {
      const data = join(root, 'vfs', REMOTE, ...item.path.split('/'))
      mkdirSync(dirname(data), { recursive: true })
      writeFileSync(data, item.content)
    }
  }
  return root
}

describe('fichiers non envoyés, avant d’effacer le cache', () => {
  it('trouve les fichiers de l’utilisateur pas encore envoyés, sans les fichiers techniques', async () => {
    const root = cache([
      { path: 'Clients/Devis.pdf', dirty: true, content: 'pdf' },
      { path: 'Clients/Envoyé.pdf', dirty: false, content: 'ok' },
      { path: 'Clients/.DS_Store', dirty: true, content: 'x' },
      { path: 'Clients/~$Contrat.docx', dirty: true, content: 'x' },
      { path: 'Note.txt', dirty: true, content: 'note' }
    ])
    const unsent = await findUnsent(root)
    expect(unsent.map((f) => f.path).sort()).toEqual(['Clients/Devis.pdf', 'Note.txt'])
  })

  it('les copie à l’abri avec leur arborescence, et compte ceux dont le contenu manque', async () => {
    const root = cache([
      { path: 'Clients/Devis.pdf', dirty: true, content: 'pdf' },
      { path: 'Perdu.txt', dirty: true }
    ])
    const target = join(root, 'sauvetage')
    const unsent = await findUnsent(root)
    expect(await rescueUnsent(unsent, target)).toBe(1)
    expect(readFileSync(join(target, 'Clients', 'Devis.pdf'), 'utf8')).toBe('pdf')
  })

  it('ne trouve rien dans un cache absent ou vide', async () => {
    expect(await findUnsent(join(tmpdir(), 'mapli-cache-inexistant'))).toEqual([])
    expect(await findUnsent(cache([]))).toEqual([])
  })

  it('nomme le dossier d’un sauvetage par la date et l’heure', () => {
    expect(rescueStamp(new Date(2026, 9, 8, 1, 5))).toBe('2026-10-08 01h05')
  })

  it('dit à la personne où sont ses fichiers non envoyés', () => {
    expect(rescueNotice(0, 0)).toBeNull()
    expect(rescueNotice(1, 1)).toBe(
      '1 fichier déposé sur ce poste n’était pas encore envoyé : il a été mis de côté dans Documents › Mapli Drive – fichiers non envoyés.'
    )
    expect(rescueNotice(3, 3)).toMatch(/^3 fichiers déposés .* ils ont été mis de côté/)
    expect(rescueNotice(3, 1)).toMatch(/ils restent dans le cache de Mapli Drive/)
  })
})
