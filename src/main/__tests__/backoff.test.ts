import { describe, expect, it } from 'vitest'
import {
  classifyClose,
  fullJitter,
  jittered,
  parseRetryAfter,
  pollRetryDelay,
  realtimeRetryDelay,
  reconnectRetryDelay
} from '../backoff'

const samples = (n: number): number[] => Array.from({ length: n }, (_, i) => i / (n - 1))

describe('rythmes tirés au hasard', () => {
  it('±20 % : entre 80 % et 120 % de l’intervalle, jamais au-delà', () => {
    for (const r of samples(50)) {
      const value = jittered(60 * 60_000, 0.2, () => r)
      expect(value).toBeGreaterThanOrEqual(48 * 60_000)
      expect(value).toBeLessThanOrEqual(72 * 60_000)
    }
    expect(jittered(180_000, 0.3, () => 0)).toBe(126_000)
    expect(jittered(180_000, 0.3, () => 1)).toBe(234_000)
  })

  it('gigue pleine : uniforme dans [0, min(plafond, base·2ⁿ)]', () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const ceiling = Math.min(60_000, 2_000 * 2 ** attempt)
      for (const r of samples(20)) {
        const value = fullJitter(attempt, 2_000, 60_000, () => r)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(ceiling)
      }
      expect(fullJitter(attempt, 2_000, 60_000, () => 1)).toBe(ceiling)
    }
  })
})

describe('Retry-After', () => {
  it('lit les secondes et les dates HTTP, plafonne à une heure', () => {
    const now = Date.parse('2026-10-06T12:00:00Z')
    expect(parseRetryAfter('120', now)).toBe(120_000)
    expect(parseRetryAfter('Tue, 06 Oct 2026 12:00:30 GMT', now)).toBe(30_000)
    expect(parseRetryAfter('Tue, 06 Oct 2026 11:00:00 GMT', now)).toBe(0)
    expect(parseRetryAfter('86400', now)).toBe(60 * 60_000)
    expect(parseRetryAfter('bientôt', now)).toBeNull()
    expect(parseRetryAfter(null, now)).toBeNull()
  })
})

describe('interrogation après un échec', () => {
  const busy = (status: number, retryAfterMs?: number) =>
    Object.assign(new Error('x'), { status, retryAfterMs })

  it('ne part jamais plus tôt que le rythme normal', () => {
    for (const r of samples(20)) {
      expect(pollRetryDelay(new Error('réseau'), 3, 180_000, 0.3, 30 * 60_000, () => r)).toBe(
        jittered(180_000, 0.3, () => r)
      )
      expect(
        pollRetryDelay(busy(503), 1, 180_000, 0.3, 30 * 60_000, () => r)
      ).toBeGreaterThanOrEqual(jittered(180_000, 0.3, () => r))
    }
  })

  it('double l’attente à chaque échec sous 429/503 (plafonnée)', () => {
    const max = (failures: number) =>
      pollRetryDelay(busy(503), failures, 180_000, 0.3, 30 * 60_000, () => 1)
    expect(max(1)).toBe(234_000 + 180_000)
    expect(max(2)).toBe(234_000 + 360_000)
    expect(max(3)).toBe(234_000 + 720_000)
    expect(max(10)).toBe(30 * 60_000)
    expect(pollRetryDelay(busy(429), 2, 20_000, 0.2, 30 * 60_000, () => 1)).toBe(24_000 + 40_000)
  })

  it('respecte le Retry-After du serveur', () => {
    expect(pollRetryDelay(busy(429, 600_000), 1, 20_000, 0.2, 30 * 60_000, () => 0)).toBe(600_000)
    expect(pollRetryDelay(busy(503, 5_000), 1, 180_000, 0.3, 30 * 60_000, () => 0)).toBe(126_000)
  })

  it('montage : gigue pleine d’au moins 1 s, jamais avant le Retry-After', () => {
    expect(reconnectRetryDelay(new Error('réseau'), 0, () => 0)).toBe(1_000)
    expect(reconnectRetryDelay(new Error('réseau'), 0, () => 1)).toBe(6_000)
    expect(reconnectRetryDelay(new Error('réseau'), 10, () => 1)).toBe(121_000)
    expect(reconnectRetryDelay(busy(503, 300_000), 0, () => 0)).toBe(300_000)
  })
})

describe('temps réel : politique de reconnexion', () => {
  it('classe les codes de fermeture (Pusher, WebSocket)', () => {
    expect(classifyClose(4001)).toBe('fatal')
    expect(classifyClose(4099)).toBe('fatal')
    expect(classifyClose(4100)).toBe('capacity')
    expect(classifyClose(4200)).toBe('restart')
    expect(classifyClose(4299)).toBe('restart')
    expect(classifyClose(1006)).toBe('restart')
    expect(classifyClose(1012)).toBe('restart')
    expect(classifyClose(1000)).toBe('other')
    expect(classifyClose(1011)).toBe('other')
    expect(classifyClose(null)).toBe('other')
  })

  it('respecte les bornes de chaque famille', () => {
    for (const r of samples(25)) {
      const random = () => r
      const fatal = realtimeRetryDelay('fatal', 0, false, random)
      expect(fatal).toBeGreaterThanOrEqual(10 * 60_000)
      expect(fatal).toBeLessThanOrEqual(20 * 60_000)
      expect(realtimeRetryDelay('capacity', 3, false, random)).toBeGreaterThanOrEqual(30_000)
      expect(realtimeRetryDelay('restart', 5, true, random)).toBeLessThanOrEqual(90_000)
      for (let n = 0; n < 10; n++) {
        const other = realtimeRetryDelay('other', n, false, random)
        expect(other).toBeLessThanOrEqual(Math.min(60_000, 2_000 * 2 ** n))
        expect(realtimeRetryDelay('restart', n, false, random)).toBeLessThanOrEqual(
          Math.min(60_000, 2_000 * 2 ** n)
        )
      }
    }
  })
})
