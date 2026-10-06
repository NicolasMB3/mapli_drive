import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FoldersResult } from '../api-payloads'
import type { InvalidationPlan } from '../invalidation'
import { LiveSync, type LiveSyncHost, type RealtimeLike } from '../live-sync'
import { RealtimeClient, type RealtimeAuth } from '../realtime'

const MIN = 60_000
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

class FakeRealtime extends EventEmitter implements RealtimeLike {
  isConnected = false
  isRunning = false
  readonly calls: string[] = []

  start(): void {
    this.isRunning = true
    this.calls.push('start')
  }

  stop(): void {
    this.isRunning = false
    this.isConnected = false
    this.calls.push('stop')
  }

  pause(): void {
    this.calls.push('pause')
  }

  resume(): void {
    this.calls.push('resume')
  }

  connect(overrides: Partial<RealtimeAuth> = {}): void {
    this.isConnected = true
    this.emit('connected', {
      key: 'k',
      host: 'app.mapli.fr',
      port: 443,
      scheme: 'https',
      channels: { org: 'private-drive.org.7', member: 'private-drive.member.7.42' },
      auth: {},
      rev: '41',
      tokenId: 9,
      ...overrides
    } satisfies RealtimeAuth)
  }

  drop(): void {
    this.isConnected = false
    this.emit('disconnected')
  }

  org(name: string, data: unknown): void {
    this.emit('event', 'org', name, data)
  }

  member(name: string, data: unknown = {}): void {
    this.emit('event', 'member', name, data)
  }
}

const FOLDERS = [
  { id: id(1), path: 'Clients' },
  { id: id(2), path: 'Clients/Factures' },
  { id: id(3), path: 'Archives' }
]

function setup(options: { realtime?: () => RealtimeLike } = {}) {
  const realtime = new FakeRealtime()
  const random = { value: 0.5 }
  const state = { rev: '41', online: true, visible: false, busy: false }
  const plans: InvalidationPlan[] = []
  const host = {
    fetchRevision: vi.fn(async () => state.rev),
    refreshStatus: vi.fn(async () => undefined),
    fetchFolders: vi.fn(
      async (): Promise<FoldersResult> => ({ notModified: false, folders: FOLDERS, etag: 'W/"1"' })
    ),
    invalidate: vi.fn(async (plan: InvalidationPlan) => {
      plans.push(plan)
    }),
    busy: vi.fn(async () => state.busy),
    windowVisible: vi.fn(() => state.visible),
    refreshRecent: vi.fn(),
    refreshPending: vi.fn(),
    revoked: vi.fn(),
    online: vi.fn(() => state.online)
  } satisfies LiveSyncHost
  const sync = new LiveSync(host, {
    createRealtime: options.realtime ?? (() => realtime),
    random: () => random.value,
    isLocked: () => false
  })
  return { sync, host, realtime, random, state, plans }
}

const flush = () => vi.advanceTimersByTimeAsync(0)

/** Démarré, connecté, table des dossiers lue, premier plan (relecture initiale) appliqué. */
async function pushing(t: ReturnType<typeof setup>): Promise<void> {
  t.sync.start()
  t.realtime.connect()
  await vi.advanceTimersByTimeAsync(5_000)
  t.plans.length = 0
  t.host.invalidate.mockClear()
  t.host.refreshPending.mockClear()
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('synchronisation : rythmes', () => {
  it('connexion temps réel établie : révision et état relus une fois par heure (±20 %)', async () => {
    const t = setup()
    t.sync.start()
    t.realtime.connect()
    expect(t.sync.mode).toBe('push')

    await vi.advanceTimersByTimeAsync(59 * MIN)
    expect(t.host.fetchRevision).not.toHaveBeenCalled()
    expect(t.host.refreshStatus).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1 * MIN)
    expect(t.host.fetchRevision).toHaveBeenCalledTimes(1)
    expect(t.host.refreshStatus).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60 * MIN)
    expect(t.host.fetchRevision).toHaveBeenCalledTimes(2)
  })

  it('les intervalles d’une heure restent entre 48 et 72 min', async () => {
    for (const [r, before, after] of [
      [0, 47.9 * MIN, 48 * MIN],
      [1, 71.9 * MIN, 72 * MIN]
    ]) {
      const t = setup()
      t.random.value = r
      t.sync.start()
      t.realtime.connect()
      await vi.advanceTimersByTimeAsync(before)
      expect(t.host.fetchRevision).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(after - before)
      expect(t.host.fetchRevision).toHaveBeenCalledTimes(1)
      t.sync.stop()
    }
  })

  it('connexion tombée depuis plus d’une minute : révision toutes les 3 min (±30 %)', async () => {
    const t = setup()
    await pushing(t)
    t.realtime.drop()
    expect(t.sync.mode).toBe('connecting')

    await vi.advanceTimersByTimeAsync(59_000)
    expect(t.host.fetchRevision).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_000 + 5_000)
    expect(t.sync.mode).toBe('degraded')
    expect(t.host.fetchRevision).toHaveBeenCalledTimes(1)

    t.random.value = 0
    t.host.fetchRevision.mockClear()
    await vi.advanceTimersByTimeAsync(180_000)
    // Le relevé suivant avait été tiré avec 0,5 (180 s) ; les suivants à 126 s (−30 %).
    expect(t.host.fetchRevision).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(126_000)
    expect(t.host.fetchRevision).toHaveBeenCalledTimes(2)
  })

  it('jamais connecté : interrogation de secours au bout d’une minute', async () => {
    const t = setup()
    t.sync.start()
    await vi.advanceTimersByTimeAsync(65_000)
    expect(t.sync.mode).toBe('degraded')
    expect(t.host.fetchRevision).toHaveBeenCalledTimes(1)
  })

  it('reconnexion : retour au rythme d’une heure', async () => {
    const t = setup()
    await pushing(t)
    t.realtime.drop()
    await vi.advanceTimersByTimeAsync(2 * MIN)
    expect(t.sync.mode).toBe('degraded')
    t.realtime.connect()
    expect(t.sync.mode).toBe('push')
    t.host.fetchRevision.mockClear()
    await vi.advanceTimersByTimeAsync(59 * MIN)
    expect(t.host.fetchRevision).not.toHaveBeenCalled()
  })

  it('veille, écran verrouillé : plus rien ne part ; au retour, la connexion repart', async () => {
    const t = setup()
    await pushing(t)
    t.sync.setSuspended(true)
    expect(t.realtime.calls).toContain('pause')
    t.sync.setLocked(true)
    await vi.advanceTimersByTimeAsync(5 * 60 * MIN)
    expect(t.host.fetchRevision).not.toHaveBeenCalled()
    expect(t.host.refreshStatus).not.toHaveBeenCalled()

    t.sync.setSuspended(false)
    expect(t.sync.mode).toBe('paused')
    t.sync.setLocked(false)
    expect(t.realtime.calls.at(-1)).toBe('resume')
    expect(t.sync.mode).toBe('connecting')
  })

  it('hors ligne : aucune requête', async () => {
    const t = setup()
    t.state.online = false
    t.sync.start()
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(t.sync.mode).toBe('degraded')
    expect(t.host.fetchRevision).not.toHaveBeenCalled()
    t.state.online = true
    await vi.advanceTimersByTimeAsync(4 * MIN)
    expect(t.host.fetchRevision).toHaveBeenCalled()
  })
})

describe('synchronisation : erreurs du serveur', () => {
  it('respecte le Retry-After et espace les relevés sous 503', async () => {
    const t = setup()
    t.host.fetchRevision.mockRejectedValue(
      Object.assign(new Error('Service Unavailable'), { status: 503, retryAfterMs: 15 * MIN })
    )
    t.sync.start()
    await vi.advanceTimersByTimeAsync(65_000)
    expect(t.host.fetchRevision).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(14 * MIN)
    expect(t.host.fetchRevision).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1 * MIN)
    expect(t.host.fetchRevision).toHaveBeenCalledTimes(2)
  })

  it('poste révoqué (401) : la déconnexion du poste est demandée', async () => {
    const t = setup()
    t.host.fetchRevision.mockRejectedValue(Object.assign(new Error('x'), { status: 401 }))
    t.sync.start()
    await vi.advanceTimersByTimeAsync(65_000)
    expect(t.host.revoked).toHaveBeenCalledTimes(1)
  })
})

describe('synchronisation : serveur sans temps réel', () => {
  it('404 sur la signature : le rythme d’avant (révision toutes les 20 s, état toutes les 5 min)', async () => {
    const authorize = vi.fn(async (): Promise<RealtimeAuth> => {
      throw Object.assign(new Error('Not Found'), { status: 404 })
    })
    const t = setup({
      realtime: () =>
        new RealtimeClient({
          version: '3.2.0',
          authorize,
          open: () => Promise.reject(new Error('jamais appelé')),
          loadEndpoint: () => null,
          saveEndpoint: () => undefined,
          clearEndpoint: () => undefined
        })
    })
    t.sync.start()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(t.sync.mode).toBe('legacy')
    expect(t.host.fetchRevision).toHaveBeenCalledTimes(1)
    // Première révision après le montage : l'Explorateur relit l'arborescence.
    await vi.advanceTimersByTimeAsync(250)
    expect(t.plans).toEqual([expect.objectContaining({ all: true })])

    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.host.fetchRevision).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(4 * MIN)
    expect(t.host.refreshStatus).toHaveBeenCalledTimes(1)

    // Une révision qui change : tout est oublié, l'espace salariés est relu.
    t.state.rev = 'f00d'
    await vi.advanceTimersByTimeAsync(20_250)
    expect(t.plans.at(-1)).toEqual(expect.objectContaining({ all: true }))
    expect(t.host.refreshPending).toHaveBeenCalled()

    // Le temps réel est réessayé par demi-heure (le serveur a pu être mis à jour).
    expect(authorize).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30 * MIN)
    expect(authorize).toHaveBeenCalledTimes(2)
  })

  it('table des dossiers absente (404) : un dossier annoncé fait tout oublier', async () => {
    const t = setup()
    t.host.fetchFolders.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }))
    await pushing(t)
    t.realtime.org('drive.changed', { rev: '42', folders: [id(1)], tree: false, trash: false })
    await vi.advanceTimersByTimeAsync(300)
    expect(t.plans).toEqual([expect.objectContaining({ all: true })])
  })
})

describe('synchronisation : événements', () => {
  it('dossiers changés : seuls ceux-là sont oubliés et relus', async () => {
    const t = setup()
    await pushing(t)
    t.realtime.org('drive.changed', {
      rev: '42',
      folders: [id(2), id(99)],
      tree: false,
      trash: false
    })
    expect(t.host.invalidate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    expect(t.plans).toEqual([
      {
        all: false,
        dirs: ['Clients/Factures'],
        trash: false,
        shell: [{ event: 'updatedir', path: 'Clients/Factures' }]
      }
    ])
  })

  it('« all » ou révision sautée : tout est oublié', async () => {
    const t = setup()
    await pushing(t)
    t.realtime.org('drive.changed', { rev: '42', folders: 'all', tree: false, trash: false })
    await vi.advanceTimersByTimeAsync(250)
    t.realtime.org('drive.changed', { rev: '45', folders: [id(1)], tree: false, trash: false })
    await vi.advanceTimersByTimeAsync(250)
    expect(t.plans.map((p) => p.all)).toEqual([true, true])
  })

  it('corbeille : transmise au lecteur (qui l’oublie pour les administrateurs)', async () => {
    const t = setup()
    await pushing(t)
    t.realtime.org('drive.changed', { rev: '42', folders: [], tree: false, trash: true })
    await vi.advanceTimersByTimeAsync(250)
    expect(t.plans).toEqual([expect.objectContaining({ all: false, trash: true, dirs: [] })])
  })

  it('arborescence changée : table relue (If-None-Match) dans les 5 s, dossiers disparus et apparus', async () => {
    const t = setup()
    await pushing(t)
    t.host.fetchFolders.mockClear()
    t.host.fetchFolders.mockResolvedValue({
      notModified: false,
      folders: [
        { id: id(1), path: 'Clients' },
        { id: id(2), path: 'Clients/Factures 2026' },
        { id: id(4), path: 'Clients/Devis' }
      ],
      etag: 'W/"2"'
    })
    t.random.value = 1
    t.realtime.org('drive.changed', {
      rev: '42',
      folders: [id(1), id(4)],
      tree: true,
      trash: false
    })
    await vi.advanceTimersByTimeAsync(250)
    expect(t.plans[0]).toEqual(expect.objectContaining({ dirs: ['Clients'] }))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.host.fetchFolders).toHaveBeenCalledWith('W/"1"')
    await vi.advanceTimersByTimeAsync(250)
    expect(t.plans[1].dirs).toEqual([
      'Archives',
      'Clients/Devis',
      'Clients/Factures',
      'Clients/Factures 2026'
    ])
    expect(t.plans[1].shell).toEqual(
      expect.arrayContaining([
        { event: 'rmdir', path: 'Archives' },
        { event: 'mkdir', path: 'Clients/Devis' },
        { event: 'rmdir', path: 'Clients/Factures' },
        { event: 'mkdir', path: 'Clients/Factures 2026' }
      ])
    )
  })

  it('table inchangée (304) : rien de plus que les dossiers annoncés', async () => {
    const t = setup()
    await pushing(t)
    t.host.fetchFolders.mockResolvedValue({ notModified: true })
    t.realtime.org('drive.changed', { rev: '42', folders: [id(3)], tree: true, trash: false })
    await vi.advanceTimersByTimeAsync(6_000)
    expect(t.plans).toEqual([expect.objectContaining({ dirs: ['Archives'] })])
  })

  it('envois en cours : l’invalidation attend leur fin', async () => {
    const t = setup()
    await pushing(t)
    t.state.busy = true
    t.realtime.org('drive.changed', { rev: '42', folders: [id(1)], tree: false, trash: false })
    t.realtime.org('drive.changed', { rev: '43', folders: [id(3)], tree: false, trash: false })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(t.host.invalidate).not.toHaveBeenCalled()

    t.state.busy = false
    t.sync.uploadsSettled()
    await flush()
    expect(t.plans).toEqual([expect.objectContaining({ dirs: ['Archives', 'Clients'] })])
  })

  it('space.changed : l’espace salariés est relu aussitôt (petite fenêtre en 1 à 2 s)', async () => {
    const t = setup()
    await pushing(t)
    t.realtime.member('space.changed')
    expect(t.host.refreshPending).toHaveBeenCalledTimes(1)
  })

  it('access.changed : tout oublier, relire la table et l’état du coffre (étalé sur 5 s)', async () => {
    const t = setup()
    await pushing(t)
    t.host.fetchFolders.mockClear()
    t.host.refreshStatus.mockClear()
    t.realtime.member('access.changed')
    await vi.advanceTimersByTimeAsync(5_250)
    expect(t.plans).toEqual([expect.objectContaining({ all: true })])
    expect(t.host.fetchFolders).toHaveBeenCalledTimes(1)
    expect(t.host.refreshStatus).toHaveBeenCalledTimes(1)
  })

  it('device.revoked : ce poste seulement (pas un autre appareil de la personne)', async () => {
    const t = setup()
    await pushing(t)
    t.realtime.member('device.revoked', { token_id: 12 })
    expect(t.host.revoked).not.toHaveBeenCalled()
    t.realtime.member('device.revoked', { token_id: 9 })
    expect(t.host.revoked).toHaveBeenCalledTimes(1)
  })

  it('reconnexion : rattrapage selon la révision signée', async () => {
    const t = setup()
    t.sync.start()
    t.realtime.connect({ rev: '41' })
    await vi.advanceTimersByTimeAsync(5_000)
    // Premier relevé après le montage : relecture de l'arborescence.
    expect(t.plans).toEqual([expect.objectContaining({ all: true })])

    t.realtime.drop()
    t.realtime.connect({ rev: '41' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.plans).toHaveLength(1)
    expect(t.host.refreshPending).toHaveBeenCalledTimes(1)

    t.realtime.drop()
    t.realtime.connect({ rev: '47' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(t.plans).toHaveLength(2)
    expect(t.plans[1].all).toBe(true)
  })

  it('fichiers récents : seulement fenêtre ouverte', async () => {
    const t = setup()
    await pushing(t)
    t.realtime.org('drive.changed', { rev: '42', folders: [id(1)], tree: false, trash: false })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(t.host.refreshRecent).not.toHaveBeenCalled()

    t.state.visible = true
    t.sync.windowShown()
    expect(t.host.refreshRecent).toHaveBeenCalledTimes(1)
    t.realtime.org('drive.changed', { rev: '43', folders: [id(1)], tree: false, trash: false })
    t.realtime.org('drive.changed', { rev: '44', folders: [id(1)], tree: false, trash: false })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(t.host.refreshRecent).toHaveBeenCalledTimes(2)
  })

  it('fenêtre ouverte : l’état du coffre est relu s’il date de plus de 5 min', async () => {
    const t = setup()
    await pushing(t)
    t.state.visible = true
    t.sync.windowShown()
    expect(t.host.refreshStatus).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6 * MIN)
    t.sync.windowShown()
    await flush()
    expect(t.host.refreshStatus).toHaveBeenCalledTimes(1)
  })
})
