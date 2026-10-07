import { describe, expect, it } from 'vitest'
import { parseEtime, sessionAgeFromPs } from '../login-launch'

describe('lancement à l’ouverture de session (macOS)', () => {
  it('lit la colonne etime de ps', () => {
    expect(parseEtime('00:42')).toBe(42_000)
    expect(parseEtime('12:05:09')).toBe((12 * 3600 + 5 * 60 + 9) * 1_000)
    expect(parseEtime('04-10:41:45')).toBe(((4 * 24 + 10) * 3600 + 41 * 60 + 45) * 1_000)
    expect(parseEtime('')).toBeNull()
    expect(parseEtime(undefined)).toBeNull()
  })

  it('date la session par le loginwindow de l’utilisateur', () => {
    const ps = [
      'root              03:00:01 /usr/libexec/logd',
      'julie             01:02:03 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow',
      'marc           1-00:00:00 /System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow'
    ].join('\n')
    expect(sessionAgeFromPs(ps, 'julie')).toBe((3600 + 2 * 60 + 3) * 1_000)
    expect(sessionAgeFromPs(ps, 'paul')).toBeNull()
  })
})
