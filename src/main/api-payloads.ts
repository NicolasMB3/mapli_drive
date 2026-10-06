import type { FolderEntry } from './invalidation'
import type { RealtimeAuth } from './realtime'

/*
 * Lecture des réponses de l'API pour la synchronisation, sans Electron pour être testée.
 * Tolérante aux deux formes (enveloppe « data » ou non) : un serveur d'une version
 * antérieure répond encore { data: { revision } } à GET /drive/revision.
 */

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null
}

/** GET /desktop/app/drive/revision → { rev } (ou { data: { revision } } avant le temps réel). */
export function parseRevision(payload: unknown): string {
  const root = record(payload)
  const data = record(root.data)
  const rev = text(root.rev) ?? text(data.rev) ?? text(data.revision) ?? text(root.revision)
  if (rev === null) throw new Error('révision illisible')
  return rev
}

/** Réponse de GET /desktop/app/drive/folders : 304 (inchangée) ou la table et son ETag. */
export type FoldersResult =
  | { notModified: true }
  | { notModified: false; folders: FolderEntry[]; etag: string | null }

/** GET /desktop/app/drive/folders → { folders: [{ id, path }] }. */
export function parseFolders(payload: unknown): FolderEntry[] {
  const root = record(payload)
  const list = Array.isArray(root.folders)
    ? root.folders
    : Array.isArray(record(root.data).folders)
      ? (record(root.data).folders as unknown[])
      : Array.isArray(root.data)
        ? root.data
        : []
  const folders: FolderEntry[] = []
  for (const item of list) {
    const entry = record(item)
    const id = text(entry.id)
    const path = typeof entry.path === 'string' ? entry.path : null
    if (id && path !== null) folders.push({ id, path })
  }
  return folders
}

/** POST /desktop/app/realtime/auth → point d'accès, canaux, signatures, révision, token. */
export function parseRealtimeAuth(payload: unknown): RealtimeAuth {
  const root = record(payload)
  const body = 'key' in root || 'auth' in root ? root : record(root.data)
  const channels = record(body.channels)
  const auth: Record<string, string> = {}
  for (const [channel, signature] of Object.entries(record(body.auth))) {
    if (typeof signature === 'string') auth[channel] = signature
  }
  const tokenId = Number(body.token_id)
  return {
    key: typeof body.key === 'string' ? body.key : '',
    host: typeof body.host === 'string' ? body.host : '',
    port: typeof body.port === 'number' ? body.port : Number(body.port),
    scheme: body.scheme === 'http' ? 'http' : 'https',
    channels: {
      org: typeof channels.org === 'string' ? channels.org : '',
      member: typeof channels.member === 'string' ? channels.member : ''
    },
    auth,
    rev: text(body.rev),
    tokenId:
      body.token_id !== undefined && body.token_id !== null && Number.isFinite(tokenId)
        ? tokenId
        : null
  }
}
