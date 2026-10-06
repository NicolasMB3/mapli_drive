import { describe, expect, it } from 'vitest'
import { rcloneMountArgs, type MountOptions } from '../rclone-args'
import { STATS_ACTIVE_MS, STATS_IDLE_MS, statsDelay, uploadsSettled } from '../upload-watch'

const idle = { transfers: 0, pendingUploads: 0, completed: 4 }

describe('suivi des envois', () => {
  it('watches closely while a file waits or leaves, and when the window is open', () => {
    expect(statsDelay(false, idle)).toBe(STATS_IDLE_MS)
    expect(statsDelay(true, idle)).toBe(STATS_ACTIVE_MS)
    expect(statsDelay(false, { ...idle, pendingUploads: 1 })).toBe(STATS_ACTIVE_MS)
    expect(statsDelay(false, { ...idle, transfers: 1 })).toBe(STATS_ACTIVE_MS)
  })

  it('never lets a dropped file wait unseen: idle checks are shorter than the write-back delay', () => {
    const args = rcloneMountArgs({ mountPoint: 'M:', cacheSizeGb: 10 } as MountOptions)
    const writeBack = args[args.indexOf('--vfs-write-back') + 1]
    expect(writeBack).toMatch(/^\d+s$/)
    expect(STATS_IDLE_MS).toBeLessThan(parseInt(writeBack, 10) * 1000)
  })

  it('tells when an upload has just finished', () => {
    // Attendait ou partait, et plus rien : terminé.
    expect(uploadsSettled({ ...idle, pendingUploads: 1 }, idle)).toBe(true)
    expect(uploadsSettled({ ...idle, transfers: 1 }, idle)).toBe(true)
    // Envoyé en un éclair entre deux relevés : le compteur de rclone l'a vu.
    expect(uploadsSettled(idle, { ...idle, completed: 5 })).toBe(true)
  })

  it('stays quiet while uploads go on, when nothing happened, or after rclone restarted', () => {
    expect(
      uploadsSettled({ ...idle, pendingUploads: 1 }, { ...idle, transfers: 1, completed: 5 })
    ).toBe(false)
    expect(uploadsSettled(idle, idle)).toBe(false)
    expect(uploadsSettled(idle, { ...idle, completed: 0 })).toBe(false)
  })
})
