import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPid,
  killRecordedOrphan,
  parseTasklist,
  PID_FILE,
  recordedPid,
  recordPid,
  type ProcessProbe
} from '../orphans'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mapli-pid-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function probe(image: string | null): ProcessProbe & { kill: ReturnType<typeof vi.fn> } {
  let alive = image !== null
  return {
    imageName: vi.fn(async () => image),
    kill: vi.fn(() => {
      alive = false
    }),
    alive: () => alive,
    sleep: async () => undefined
  }
}

describe('rclone laissé par une session précédente', () => {
  it('note le PID au montage et l’efface à l’arrêt (le sien seulement)', async () => {
    await recordPid(dir, 4242)
    expect(await recordedPid(dir)).toBe(4242)
    await clearPid(dir, 1111)
    expect(await recordedPid(dir)).toBe(4242)
    await clearPid(dir, 4242)
    expect(existsSync(join(dir, PID_FILE))).toBe(false)
  })

  it('arrête le rclone noté s’il tourne encore', async () => {
    await recordPid(dir, 4242)
    const p = probe('rclone.exe')
    expect(await killRecordedOrphan(dir, p)).toBe('killed')
    expect(p.kill).toHaveBeenCalledWith(4242)
    expect(await recordedPid(dir)).toBeNull()
  })

  it('ne touche pas à un autre programme qui aurait repris le PID', async () => {
    await recordPid(dir, 4242)
    const p = probe('notepad.exe')
    expect(await killRecordedOrphan(dir, p)).toBe('other-process')
    expect(p.kill).not.toHaveBeenCalled()
    expect(await recordedPid(dir)).toBeNull()
  })

  it('rien de noté, ou processus déjà parti : rien à faire', async () => {
    expect(await killRecordedOrphan(dir, probe('rclone.exe'))).toBe('none')
    await recordPid(dir, 4242)
    expect(await killRecordedOrphan(dir, probe(null))).toBe('gone')
  })

  it('lit la sortie de tasklist (et son message quand rien ne correspond)', () => {
    expect(parseTasklist('"rclone.exe","4242","Console","1","25 000 Ko"\r\n')).toBe('rclone.exe')
    expect(
      parseTasklist(
        'Information : aucune tâche en service ne correspond aux critères spécifiés.\r\n'
      )
    ).toBeNull()
  })
})

describe.runIf(process.platform === 'win32')('tasklist réel (Windows)', () => {
  it('donne le nom de l’image d’un processus, et rien pour un PID libre', () => {
    const tasklist = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe')
    const run = (pid: number): string =>
      execFileSync(tasklist, ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        windowsHide: true
      }).toString()
    expect(parseTasklist(run(process.pid))?.toLowerCase()).toMatch(/\.exe$/)
    // Les PID de Windows sont des multiples de 4 : celui-ci ne désigne jamais un processus.
    expect(parseTasklist(run(999_999))).toBeNull()
  })
})
