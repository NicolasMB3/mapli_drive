import { app, net } from 'electron'
import { API_URL } from './config'

/*
 * Client de l'API Mapli (appairage du poste, état du lecteur). Passe par le réseau
 * d'Electron (proxy et certificats du système), avec un délai maximal par requête.
 */

const TIMEOUT_MS = 20_000

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message)
  }
}

/** Réseau ou serveur injoignable (par opposition à une réponse d'erreur du serveur). */
export class NetworkError extends Error {}

async function request<T>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {}
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  let response: Response
  try {
    response = await net.fetch(`${API_URL}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': `MapliDrive/${app.getVersion()}`,
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    })
  } catch {
    throw new NetworkError('Mapli est injoignable. Vérifiez votre connexion internet.')
  } finally {
    clearTimeout(timer)
  }

  const payload = (await response.json().catch(() => ({}))) as { message?: string } & T
  if (!response.ok) {
    throw new ApiError(payload.message || `Erreur ${response.status}`, response.status)
  }

  return payload
}

export interface PairingStart {
  device_code: string
  device_secret: string
  verification_url: string
  verification_url_complete: string
  poll_interval: number
  expires_in: number
}

export type PairingPoll =
  | { status: 'pending' | 'denied' | 'expired' | 'claimed' }
  | {
      status: 'approved'
      token: string
      user: { first_name: string; last_name: string; email: string }
      organization: { id: string; name: string } | null
    }

export interface DriveStatusPayload {
  user: { first_name: string; last_name: string; email: string }
  organization: { id: string; name: string }
  storage: {
    used_bytes: number
    limit_bytes: number
    trash_bytes: number
    member_used_bytes: number
    member_limit_bytes: number | null
  }
  permissions: { view: boolean; upload: boolean; delete: boolean; manage_folders: boolean }
  dav_url: string
  finder_url: string
  max_file_size: number
}

export interface RecentFilePayload {
  id: string
  name: string
  folder: string | null
  size_bytes: number
  mine: boolean
  created_at: string
}

export const api = {
  startPairing: (deviceName: string, platform: string) =>
    request<{ data: PairingStart }>('POST', '/desktop/pairing/start', {
      body: { device_name: deviceName, platform }
    }).then((r) => r.data),

  pollPairing: (code: string, secret: string) =>
    request<{ data: PairingPoll }>('POST', '/desktop/pairing/poll', {
      body: { device_code: code, device_secret: secret }
    }).then((r) => r.data),

  driveStatus: (token: string) =>
    request<{ data: DriveStatusPayload }>('GET', '/desktop/app/drive', { token }).then(
      (r) => r.data
    ),

  /** Empreinte du coffre : change dès que son contenu ou ses accès changent. */
  driveRevision: (token: string) =>
    request<{ data: { revision: string } }>('GET', '/desktop/app/drive/revision', { token }).then(
      (r) => r.data.revision
    ),

  recent: (token: string) =>
    request<{ data: RecentFilePayload[] }>('GET', '/desktop/app/drive/recent', { token }).then(
      (r) => r.data
    ),

  disconnect: (token: string) =>
    request<{ message: string }>('DELETE', '/desktop/app/session', { token })
}
