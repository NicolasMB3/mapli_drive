import { describe, expect, it } from 'vitest'
import type { EmployeeSpaceState } from '../../shared/types'
import {
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
