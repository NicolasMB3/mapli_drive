import { describe, expect, it } from 'vitest'
import { parseFolders, parseRealtimeAuth, parseRevision } from '../api-payloads'

describe('réponses de l’API pour la synchronisation', () => {
  it('révision : forme du temps réel, et celle d’un serveur d’avant', () => {
    expect(parseRevision({ rev: '42' })).toBe('42')
    expect(parseRevision({ rev: 42 })).toBe('42')
    expect(parseRevision({ data: { revision: 'a1b2c3' } })).toBe('a1b2c3')
    expect(() => parseRevision({})).toThrow()
  })

  it('table des dossiers : identifiants et chemins, le reste écarté', () => {
    expect(
      parseFolders({
        folders: [
          { id: 'a', path: 'Clients' },
          { id: 'b', path: 'Clients/Factures' },
          { id: 'c' },
          'n’importe quoi'
        ]
      })
    ).toEqual([
      { id: 'a', path: 'Clients' },
      { id: 'b', path: 'Clients/Factures' }
    ])
    expect(parseFolders({ data: { folders: [{ id: 'a', path: 'X' }] } })).toEqual([
      { id: 'a', path: 'X' }
    ])
    expect(parseFolders(null)).toEqual([])
  })

  it('signature temps réel : point d’accès, canaux, signatures, révision, token', () => {
    const payload = {
      key: 'drive-key',
      host: 'app.mapli.fr',
      port: 443,
      scheme: 'https',
      channels: { org: 'private-drive.org.7', member: 'private-drive.member.7.42' },
      auth: {
        'private-drive.org.7': 'drive-key:abc',
        'private-drive.member.7.42': 'drive-key:def'
      },
      rev: 41,
      token_id: 9
    }
    expect(parseRealtimeAuth(payload)).toEqual({
      key: 'drive-key',
      host: 'app.mapli.fr',
      port: 443,
      scheme: 'https',
      channels: { org: 'private-drive.org.7', member: 'private-drive.member.7.42' },
      auth: {
        'private-drive.org.7': 'drive-key:abc',
        'private-drive.member.7.42': 'drive-key:def'
      },
      rev: '41',
      tokenId: 9
    })
    expect(parseRealtimeAuth({ data: payload }).tokenId).toBe(9)
    expect(parseRealtimeAuth({ ...payload, token_id: null, rev: undefined })).toEqual(
      expect.objectContaining({ tokenId: null, rev: null })
    )
  })
})
