import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BOOTSTRAP_SOCKET_ID,
  PONG_TIMEOUT_MS,
  RealtimeClient,
  type RealtimeAuth,
  type RealtimeEndpoint,
  type RealtimeSocket,
  type SocketHandlers
} from '../realtime'

const ORG = 'private-drive.org.7'
const MEMBER = 'private-drive.member.7.42'
const ENDPOINT: RealtimeEndpoint = {
  key: 'drive-key',
  host: 'app.mapli.fr',
  port: 443,
  scheme: 'https'
}

const MIN = 60_000

function auth(overrides: Partial<RealtimeAuth> = {}): RealtimeAuth {
  return {
    ...ENDPOINT,
    channels: { org: ORG, member: MEMBER },
    auth: { [ORG]: 'drive-key:sig-org', [MEMBER]: 'drive-key:sig-member' },
    rev: '41',
    tokenId: 9,
    ...overrides
  }
}

class FakeSocket implements RealtimeSocket {
  sent: { event: string; data: unknown }[] = []
  closedWith: number | null = null
  terminated = false

  constructor(
    readonly url: string,
    private readonly handlers: SocketHandlers
  ) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data))
  }

  close(code = 1000): void {
    this.closedWith = code
  }

  terminate(): void {
    this.terminated = true
  }

  /** Message du serveur (data encodée en JSON, comme Reverb). */
  receive(event: string, data: unknown = {}, channel?: string): void {
    this.handlers.onMessage(JSON.stringify({ event, channel, data: JSON.stringify(data) }))
  }

  serverClose(code: number): void {
    this.handlers.onClose(code)
  }

  events(name: string): unknown[] {
    return this.sent.filter((m) => m.event === name)
  }
}

function setup(
  options: {
    endpoint?: RealtimeEndpoint | null
    authorize?: (socketId: string) => Promise<RealtimeAuth>
    openFails?: boolean
    online?: () => boolean
  } = {}
) {
  const sockets: FakeSocket[] = []
  let endpoint = options.endpoint === undefined ? ENDPOINT : options.endpoint
  const saved: RealtimeEndpoint[] = []
  const random = { value: 0.5 }
  const authorize = vi.fn(options.authorize ?? (async () => auth()))
  const client = new RealtimeClient({
    version: '3.2.0',
    authorize,
    open: async (url, handlers) => {
      if (options.openFails) throw new Error('ECONNREFUSED')
      const socket = new FakeSocket(url, handlers)
      sockets.push(socket)
      return socket
    },
    loadEndpoint: () => endpoint,
    saveEndpoint: (e) => {
      endpoint = e
      saved.push(e)
    },
    clearEndpoint: () => {
      endpoint = null
    },
    online: options.online,
    random: () => random.value
  })
  const events = {
    connected: vi.fn(),
    disconnected: vi.fn(),
    unsupported: vi.fn(),
    unauthorized: vi.fn(),
    blocked: vi.fn(),
    event: vi.fn()
  }
  for (const [name, fn] of Object.entries(events)) client.on(name, fn)
  return {
    client,
    sockets,
    authorize,
    events,
    random,
    saved,
    endpoint: () => endpoint,
    last: () => sockets[sockets.length - 1]
  }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

/** Connexion complète : établie, signée, abonnée aux deux canaux. */
async function connect(socket: FakeSocket, activity = 30): Promise<void> {
  socket.receive('pusher:connection_established', {
    socket_id: '123.456',
    activity_timeout: activity
  })
  await flush()
  socket.receive('pusher_internal:subscription_succeeded', {}, ORG)
  socket.receive('pusher_internal:subscription_succeeded', {}, MEMBER)
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('client temps réel : connexion', () => {
  it('se connecte à Reverb, signe les deux canaux privés et s’y abonne', async () => {
    const t = setup()
    t.client.start()
    await flush()

    expect(t.sockets).toHaveLength(1)
    expect(t.last().url).toBe(
      'wss://app.mapli.fr/app/drive-key?protocol=7&client=mapli-drive&version=3.2.0'
    )
    t.last().receive('pusher:connection_established', {
      socket_id: '123.456',
      activity_timeout: 30
    })
    await flush()

    expect(t.authorize).toHaveBeenCalledWith('123.456')
    expect(t.last().sent).toEqual([
      { event: 'pusher:subscribe', data: { channel: ORG, auth: 'drive-key:sig-org' } },
      { event: 'pusher:subscribe', data: { channel: MEMBER, auth: 'drive-key:sig-member' } }
    ])

    t.last().receive('pusher_internal:subscription_succeeded', {}, ORG)
    expect(t.events.connected).not.toHaveBeenCalled()
    t.last().receive('pusher_internal:subscription_succeeded', {}, MEMBER)
    expect(t.events.connected).toHaveBeenCalledWith(
      expect.objectContaining({ rev: '41', tokenId: 9 })
    )
    expect(t.client.isConnected).toBe(true)
  })

  it('premier lancement : demande la clé Reverb à l’API, la garde, puis se connecte', async () => {
    const t = setup({ endpoint: null })
    t.client.start()
    await flush()

    expect(t.authorize).toHaveBeenNthCalledWith(1, BOOTSTRAP_SOCKET_ID)
    expect(t.saved).toEqual([ENDPOINT])
    expect(t.last().url).toContain('wss://app.mapli.fr/app/drive-key?')
  })

  it('refuse une adresse non chiffrée (ws://) hors développement', async () => {
    const t = setup({ endpoint: null, authorize: async () => auth({ scheme: 'http', port: 80 }) })
    t.client.start()
    await flush()
    expect(t.sockets).toHaveLength(0)
    expect(t.client.lastRetryDelay).toBeGreaterThanOrEqual(10 * MIN)
  })

  it('se reconnecte avec la nouvelle clé si le serveur en a changé', async () => {
    const fresh = { ...ENDPOINT, key: 'new-key' }
    const t = setup({ authorize: async () => auth(fresh) })
    t.client.start()
    await flush()
    t.last().receive('pusher:connection_established', { socket_id: '1.2' })
    await flush()

    expect(t.saved).toEqual([fresh])
    expect(t.sockets[0].closedWith).toBe(1000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(t.last().url).toContain('/app/new-key?')
  })
})

describe('client temps réel : événements', () => {
  it('transmet les événements du serveur, pas ceux des autres clients ni d’autres canaux', async () => {
    const t = setup()
    t.client.start()
    await flush()
    await connect(t.last())

    t.last().receive('drive.changed', { rev: '42', folders: ['a'], tree: false, trash: false }, ORG)
    t.last().receive('client-drive.changed', { rev: '99' }, ORG)
    t.last().receive('space.changed', {}, 'private-other')
    t.last().receive('device.revoked', { token_id: 9 }, MEMBER)

    expect(t.events.event.mock.calls).toEqual([
      ['org', 'drive.changed', { rev: '42', folders: ['a'], tree: false, trash: false }],
      ['member', 'device.revoked', { token_id: 9 }]
    ])
  })

  it('garde les événements d’un canal abonné avant l’autre jusqu’à la fin de la connexion', async () => {
    const t = setup()
    t.client.start()
    await flush()
    t.last().receive('pusher:connection_established', { socket_id: '1.2' })
    await flush()
    t.last().receive('pusher_internal:subscription_succeeded', {}, ORG)
    t.last().receive('drive.changed', { rev: '42' }, ORG)
    expect(t.events.event).not.toHaveBeenCalled()

    t.last().receive('pusher_internal:subscription_succeeded', {}, MEMBER)
    expect(t.events.connected).toHaveBeenCalledTimes(1)
    expect(t.events.event).toHaveBeenCalledWith('org', 'drive.changed', { rev: '42' })
  })

  it('répond au pusher:ping du serveur', async () => {
    const t = setup()
    t.client.start()
    await flush()
    await connect(t.last())
    t.last().receive('pusher:ping')
    expect(t.last().events('pusher:pong')).toHaveLength(1)
  })
})

describe('client temps réel : silence et connexion morte', () => {
  it('envoie pusher:ping après le délai d’inactivité, et garde la connexion si le serveur répond', async () => {
    const t = setup()
    t.client.start()
    await flush()
    await connect(t.last(), 30)

    await vi.advanceTimersByTimeAsync(29_000)
    expect(t.last().events('pusher:ping')).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(t.last().events('pusher:ping')).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(5_000)
    t.last().receive('pusher:pong')
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS)
    expect(t.last().terminated).toBe(false)
    expect(t.client.isConnected).toBe(true)
  })

  it('abandonne la connexion sans pusher:pong sous 15 s, puis se reconnecte (premier essai étalé sur 90 s)', async () => {
    const t = setup()
    t.random.value = 1
    t.client.start()
    await flush()
    await connect(t.last(), 30)

    await vi.advanceTimersByTimeAsync(30_000 + PONG_TIMEOUT_MS)
    expect(t.sockets[0].terminated).toBe(true)
    expect(t.events.disconnected).toHaveBeenCalledTimes(1)
    expect(t.client.lastRetryDelay).toBe(90_000)

    await vi.advanceTimersByTimeAsync(90_000)
    expect(t.sockets).toHaveLength(2)
  })
})

describe('client temps réel : fermetures et reprises', () => {
  async function connectedClient() {
    const t = setup()
    t.client.start()
    await flush()
    await connect(t.last())
    return t
  }

  it('4000–4099 (accès refusé) : nouvel essai dans 10 à 20 min', async () => {
    const t = await connectedClient()
    t.random.value = 0
    t.last().receive('pusher:error', { code: 4009, message: 'Connection is unauthorized' })
    expect(t.last().closedWith).toBe(1000)
    expect(t.client.lastRetryDelay).toBe(10 * MIN)

    const u = await connectedClient()
    u.random.value = 1
    u.last().serverClose(4001)
    expect(u.client.lastRetryDelay).toBe(20 * MIN)
  })

  it('application inconnue avec une clé gardée : la clé est oubliée et redemandée sans attendre 10 min', async () => {
    const t = await connectedClient()
    t.last().receive('pusher:error', { code: 4001, message: 'Application does not exist' })
    expect(t.endpoint()).toBeNull()
    expect(t.client.lastRetryDelay).toBeLessThanOrEqual(2_000)
  })

  it('4100–4199 (serveur plein) : au moins 30 s', async () => {
    const t = await connectedClient()
    t.random.value = 0
    t.last().serverClose(4100)
    expect(t.client.lastRetryDelay).toBe(30_000)
  })

  it('4200–4299, 1006 et 1012 : premier essai tiré entre 0 et 90 s', async () => {
    for (const code of [4200, 4201, 1006, 1012]) {
      const t = await connectedClient()
      t.random.value = 1
      t.last().serverClose(code)
      expect(t.client.lastRetryDelay).toBe(90_000)
      const u = await connectedClient()
      u.random.value = 0
      u.last().serverClose(code)
      expect(u.client.lastRetryDelay).toBe(0)
    }
  })

  it('autres fermetures : gigue pleine, plafonnée à min(60 s, 2 s·2ⁿ)', async () => {
    const t = setup({ openFails: true })
    t.random.value = 1
    t.client.start()
    await flush()
    const delays: number[] = []
    for (let i = 0; i < 6; i++) {
      delays.push(t.client.lastRetryDelay ?? -1)
      await vi.advanceTimersByTimeAsync(t.client.lastRetryDelay ?? 0)
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000])
  })

  it('oublie les échecs passés après 5 min de connexion stable', async () => {
    const t = setup()
    t.random.value = 1
    t.client.start()
    await flush()
    // Trois échecs d'affilée…
    for (let i = 0; i < 3; i++) {
      t.last().serverClose(1000)
      await vi.advanceTimersByTimeAsync(t.client.lastRetryDelay ?? 0)
    }
    await connect(t.last(), 600)
    await vi.advanceTimersByTimeAsync(5 * MIN)
    t.last().serverClose(1000)
    expect(t.client.lastRetryDelay).toBe(2_000)
  })

  it('WebSockets bloqués (8 échecs d’ouverture) : signalé, puis un essai toutes les 10 à 20 min', async () => {
    const t = setup({ openFails: true })
    t.client.start()
    await flush()
    // 1er échec au démarrage, puis 6 autres : pas encore de conclusion.
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(t.client.lastRetryDelay ?? 0)
    expect(t.events.blocked).not.toHaveBeenCalled()
    expect(t.client.lastRetryDelay).toBeLessThanOrEqual(60_000)

    t.random.value = 0
    await vi.advanceTimersByTimeAsync(t.client.lastRetryDelay ?? 0)
    expect(t.events.blocked).toHaveBeenCalledTimes(1)
    expect(t.client.lastRetryDelay).toBe(10 * MIN)
    t.random.value = 1
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(t.client.lastRetryDelay).toBe(20 * MIN)
    expect(t.events.blocked).toHaveBeenCalledTimes(1)
  })

  it('hors ligne : aucun essai, et aucun échec compté', async () => {
    let online = false
    const t = setup({ online: () => online })
    t.client.start()
    await vi.advanceTimersByTimeAsync(10 * MIN)
    expect(t.sockets).toHaveLength(0)
    expect(t.events.blocked).not.toHaveBeenCalled()
    online = true
    await vi.advanceTimersByTimeAsync(15_000)
    expect(t.sockets).toHaveLength(1)
  })

  it('respecte le Retry-After de l’API de signature (429)', async () => {
    const t = setup({
      authorize: async () => {
        throw Object.assign(new Error('Too Many Requests'), { status: 429, retryAfterMs: 120_000 })
      }
    })
    t.client.start()
    await flush()
    t.last().receive('pusher:connection_established', { socket_id: '1.2' })
    await flush()
    expect(t.client.lastRetryDelay).toBeGreaterThanOrEqual(120_000)
  })
})

describe('client temps réel : serveur, veille et révocation', () => {
  it('serveur sans temps réel (404) : le signale et ne réessaie pas de lui-même', async () => {
    const t = setup({
      endpoint: null,
      authorize: async () => {
        throw Object.assign(new Error('Not Found'), { status: 404 })
      }
    })
    t.client.start()
    await flush()
    expect(t.events.unsupported).toHaveBeenCalledTimes(1)
    expect(t.client.state).toBe('idle')
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(t.sockets).toHaveLength(0)
    expect(t.authorize).toHaveBeenCalledTimes(1)
  })

  it('poste révoqué (401 à la signature) : le signale et s’arrête', async () => {
    const t = setup({
      authorize: async () => {
        throw Object.assign(new Error('Unauthenticated'), { status: 401 })
      }
    })
    t.client.start()
    await flush()
    t.last().receive('pusher:connection_established', { socket_id: '1.2' })
    await flush()
    expect(t.events.unauthorized).toHaveBeenCalledTimes(1)
    expect(t.last().closedWith).toBe(1000)
    expect(t.client.isRunning).toBe(false)
  })

  it('veille : ferme la connexion, rien ne repart avant le réveil, puis reconnexion en 1 à 10 s', async () => {
    const t = setup()
    t.client.start()
    await flush()
    await connect(t.last())

    t.client.pause()
    expect(t.sockets[0].closedWith).toBe(1000)
    expect(t.events.disconnected).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(t.sockets).toHaveLength(1)

    t.random.value = 1
    t.client.resume()
    expect(t.client.lastRetryDelay).toBe(10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(t.sockets).toHaveLength(2)

    t.client.pause()
    t.random.value = 0
    t.client.resume()
    expect(t.client.lastRetryDelay).toBe(1_000)
  })
})
