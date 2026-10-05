import { describe, expect, it } from 'vitest'
import { fileExtension, fileKind, fileLabel } from '../file-kind'

describe('fileKind', () => {
  it('reconnaît les familles courantes, sans tenir compte de la casse', () => {
    expect(fileKind('Devis-Lenoir.PDF')).toBe('pdf')
    expect(fileKind('Compte rendu.docx')).toBe('text')
    expect(fileKind('Planning chantier.xlsx')).toBe('sheet')
    expect(fileKind('Présentation.pptx')).toBe('slides')
    expect(fileKind('IMG_2041.HEIC')).toBe('image')
    expect(fileKind('Visite.mov')).toBe('video')
    expect(fileKind('Répondeur.m4a')).toBe('audio')
    expect(fileKind('Photos.7z')).toBe('archive')
  })

  it('se fie au nom du fichier, pas au dossier', () => {
    expect(fileKind('Photos-chantier/IMG_2041.jpg')).toBe('image')
    expect(fileKind('Archives.zip\\notes.txt')).toBe('text')
  })

  it('range le reste dans « autre »', () => {
    expect(fileKind('Makefile')).toBe('other')
    expect(fileKind('.bashrc')).toBe('other')
    expect(fileKind('plan.dwg')).toBe('other')
  })
})

describe('fileLabel', () => {
  it('donne l’extension en capitales, quatre lettres au plus', () => {
    expect(fileLabel('Devis.pdf')).toBe('PDF')
    expect(fileLabel('Budget.numbers')).toBe('NUMB')
    expect(fileLabel('Makefile')).toBe('')
    expect(fileExtension('archive.tar.gz')).toBe('gz')
  })
})
