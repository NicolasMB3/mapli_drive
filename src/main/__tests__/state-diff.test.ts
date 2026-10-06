import { describe, expect, it } from 'vitest'
import { changedKeys, menuSignature, sameValue } from '../state-diff'

describe('état : redessiner seulement ce qui change', () => {
  const state = {
    phase: 'connected',
    pendingUploads: 0,
    transfers: [] as { name: string }[],
    recent: [{ id: '1', name: 'Devis.pdf' }],
    storage: { usedBytes: 10, limitBytes: 100 }
  }

  it('ignore une mise à jour identique (relevé des envois sans nouveauté, même liste récente)', () => {
    expect(
      changedKeys(state, {
        pendingUploads: 0,
        transfers: [],
        recent: [{ id: '1', name: 'Devis.pdf' }],
        storage: { usedBytes: 10, limitBytes: 100 }
      })
    ).toEqual([])
  })

  it('repère ce qui a vraiment changé', () => {
    expect(changedKeys(state, { phase: 'offline', pendingUploads: 0 })).toEqual(['phase'])
    expect(changedKeys(state, { transfers: [{ name: 'IMG_2041.jpg' }] })).toEqual(['transfers'])
    expect(sameValue(null, {})).toBe(false)
    expect(sameValue(NaN, NaN)).toBe(true)
  })

  it('menu de la zone de notification : la signature ne dépend que de ce qui s’y voit', () => {
    const click = (): void => undefined
    const a = menuSignature([
      { label: 'Lecteur M: · à jour', enabled: false },
      { type: 'separator' }
    ])
    const b = menuSignature([
      { label: 'Lecteur M: · à jour', enabled: false, click } as {
        label: string
        enabled: boolean
      },
      { type: 'separator' }
    ])
    expect(a).toBe(b)
    expect(menuSignature([{ label: 'Envoi en cours (1)', enabled: false }])).not.toBe(a)
  })
})
