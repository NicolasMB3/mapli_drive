import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readLogTail, trimLog } from '../rclone-log'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mapli-log-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const lines = (from: number, to: number): string =>
  Array.from({ length: to - from }, (_, i) => `ligne ${String(from + i).padStart(6, '0')}\n`).join(
    ''
  )

describe('journal de rclone', () => {
  it('le laisse tel quel sous la limite', async () => {
    const file = join(dir, 'rclone.log')
    writeFileSync(file, lines(0, 100))
    expect(await trimLog(file, 10_000, 1_000)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(lines(0, 100))
  })

  it('au-delà de la limite, ne garde que la fin, à partir d’une ligne entière', async () => {
    const file = join(dir, 'rclone.log')
    writeFileSync(file, lines(0, 2_000)) // 2 000 lignes de 13 octets
    expect(await trimLog(file, 10_000, 1_000)).toBe(true)
    const kept = readFileSync(file, 'utf8')
    expect(kept.length).toBeLessThanOrEqual(1_000)
    expect(kept.startsWith('ligne ')).toBe(true)
    expect(kept.endsWith(lines(1_999, 2_000))).toBe(true)
  })

  it('journal absent : rien à faire', async () => {
    expect(await trimLog(join(dir, 'absent.log'))).toBe(false)
    expect(await readLogTail(join(dir, 'absent.log'))).toBe('')
  })

  it('pour expliquer un échec, ne lit que la fin', async () => {
    const file = join(dir, 'rclone.log')
    writeFileSync(file, lines(0, 5_000) + 'ERROR : cgofuse: cannot find winfsp\n')
    const tail = await readLogTail(file, 200)
    expect(tail.length).toBe(200)
    expect(tail).toContain('cannot find winfsp')
    expect(tail).not.toContain('ligne 000000')
  })
})
