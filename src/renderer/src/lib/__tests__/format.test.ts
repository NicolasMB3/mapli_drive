import { describe, expect, it } from 'vitest'
import { baseName, formatBytes, formatRelative, plural } from '../format'

describe('formatBytes', () => {
  it('formats sizes the French way', () => {
    expect(formatBytes(0)).toBe('0 o')
    expect(formatBytes(512)).toBe('512 o')
    expect(formatBytes(1536)).toBe('1,5 Ko')
    expect(formatBytes(13.3e9)).toBe('12 Go')
  })
})

describe('formatRelative', () => {
  const now = new Date('2026-10-05T12:00:00Z').getTime()
  it('says how long ago a file was added', () => {
    expect(formatRelative('2026-10-05T11:59:40Z', now)).toBe('à l’instant')
    expect(formatRelative('2026-10-05T11:56:00Z', now)).toBe('il y a 4 min')
    expect(formatRelative('2026-10-05T09:00:00Z', now)).toBe('il y a 3 h')
    expect(formatRelative('2026-10-04T10:00:00Z', now)).toBe('hier')
  })
})

describe('helpers', () => {
  it('keeps the last segment of a path', () => {
    expect(baseName('Photos-chantier/IMG_2041.jpg')).toBe('IMG_2041.jpg')
    expect(baseName('Dossier\\Devis.pdf')).toBe('Devis.pdf')
  })

  it('pluralizes', () => {
    expect(plural(1, 'fichier')).toBe('1 fichier')
    expect(plural(3, 'fichier')).toBe('3 fichiers')
  })
})
