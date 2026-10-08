import { describe, expect, it } from 'vitest'
import {
  ancestorDirs,
  isSystemFile,
  isTemporaryFile,
  refusalNotice,
  refusalReason,
  summarizeQueue,
  uploadErrors,
  type QueueItem
} from '../upload-queue'

const item = (name: string, tries = 0, uploading = false): QueueItem => ({ name, tries, uploading })

describe('file d’envoi de rclone', () => {
  it('reconnaît les fichiers du système et les fichiers temporaires', () => {
    for (const name of ['.DS_Store', 'Espace salariés/._.DS_Store', 'a/._Devis.pdf', 'Thumbs.db'])
      expect(isSystemFile(name)).toBe(true)
    expect(isSystemFile('Clients/desktop.ini')).toBe(true)
    expect(isSystemFile('Clients/._')).toBe(true)
    expect(isSystemFile('Clients/Devis.pdf')).toBe(false)
    expect(isSystemFile('Clients/.DS_Store/notes.txt')).toBe(false)
    for (const name of ['a/~$Contrat.docx', '.~lock.Budget.ods#', 'x/~WRL0001.tmp', 'f.crdownload'])
      expect(isTemporaryFile(name)).toBe(true)
    expect(isTemporaryFile('Contrat.docx')).toBe(false)
  })

  it('compte comme en cours ce qui avance, pas ce qui attend après un refus', () => {
    const summary = summarizeQueue([
      item('Clients/Devis.pdf'),
      item('Clients/Gros.zip', 1, true),
      item('Clients/Refusé.pdf', 3),
      item('Clients/~$Contrat.docx', 2),
      item('Espace salariés/.DS_Store', 1),
      item('Clients/._Devis.pdf')
    ])
    expect(summary.active).toBe(3)
    expect(summary.pending).toBe(3)
    expect(summary.failing).toEqual(['Clients/Refusé.pdf'])
    expect(summary.discard).toEqual(['Espace salariés/.DS_Store'])
  })

  it('ne jette un fichier du système qu’après un refus, et jamais pendant son envoi', () => {
    expect(summarizeQueue([item('a/.DS_Store'), item('b/.DS_Store', 2, true)]).discard).toEqual([])
  })

  it('lit dans le journal la dernière erreur de chaque fichier', () => {
    const log = [
      '2026/10/08 01:02:26 ERROR : Espace salariés/.DS_Store: Failed to copy: unchunked simple update failed: Vous n’avez pas le droit d’ajouter des fichiers ici.: 403 Forbidden',
      '2026/10/08 01:02:26 ERROR : Clients/Devis: v2.pdf: vfs cache: failed to upload try #1, will retry in 6s: vfs cache: failed to transfer file from cache to remote: 507 Insufficient Storage',
      '2026/10/08 01:02:52 ERROR : Clients/Devis: v2.pdf: vfs cache: failed to upload try #2, will retry in 1m36s: vfs cache: failed to transfer file from cache to remote: dial tcp: i/o timeout',
      '2026/10/08 01:03:41 NOTICE: autre chose'
    ].join('\n')
    expect([...uploadErrors(log)]).toEqual([
      [
        'Clients/Devis: v2.pdf',
        'vfs cache: failed to transfer file from cache to remote: dial tcp: i/o timeout'
      ]
    ])
  })

  it('dit pourquoi un envoi est refusé, et se tait pour une coupure passagère', () => {
    expect(refusalReason('Failed to copy: 507 Insufficient Storage')).toMatch(/espace de stockage/)
    expect(refusalReason('413 Request Entity Too Large')).toMatch(/taille maximale/)
    expect(refusalReason('unchunked simple update failed: Refusé.: 403 Forbidden')).toMatch(
      /ne peut pas ajouter/
    )
    expect(refusalReason('dial tcp: i/o timeout')).toBeNull()
    expect(refusalReason('502 Bad Gateway')).toBeNull()
    expect(refusalReason(undefined)).toBeNull()
  })

  it('nomme le fichier refusé dans l’alerte, et le nombre s’il y en a plusieurs', () => {
    const errors = new Map([
      ['Clients/Devis.pdf', 'failed: 403 Forbidden'],
      ['Clients/Note.txt', 'failed: 507 Insufficient Storage'],
      ['Clients/Lent.pdf', 'dial tcp: i/o timeout']
    ])
    expect(refusalNotice(['Clients/Devis.pdf'], errors)).toBe(
      '« Devis.pdf » n’a pas été envoyé : votre compte ne peut pas ajouter ni modifier de fichiers dans ce dossier.'
    )
    expect(
      refusalNotice(['Clients/Lent.pdf', 'Clients/Note.txt', 'Clients/Devis.pdf'], errors)
    ).toMatch(/^2 fichiers n’ont pas été envoyés, dont « Note\.txt » : l’espace de stockage/)
    expect(refusalNotice(['Clients/Lent.pdf'], errors)).toBeNull()
    expect(refusalNotice([], errors)).toBeNull()
  })

  it('donne les dossiers qui contiennent des envois en attente, parents et racine compris', () => {
    expect([...ancestorDirs(['Clients/2026/Devis.pdf', 'Note.txt'])].sort()).toEqual([
      '',
      'Clients',
      'Clients/2026'
    ])
    expect(ancestorDirs([]).size).toBe(0)
  })
})
