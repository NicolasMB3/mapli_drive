import { describe, expect, it } from 'vitest'
import { redact } from '../log'

describe('journal', () => {
  it('masque les jetons et mots de passe', () => {
    expect(redact('Authorization: Bearer 42|abcdefghijklmnopqrstuvwxyz0123')).not.toContain(
      'abcdefghij'
    )
    expect(redact('jeton 17|AbCdEfGhIjKlMnOpQrStUvWxYz')).toBe('jeton [jeton masqué]')
    expect(redact('password="tr0p-secret" ok')).not.toContain('tr0p-secret')
  })

  it('laisse le reste intact', () => {
    expect(redact('lecteur monté (rclone) sur /Users/julie/Mapli en 1.2 s')).toBe(
      'lecteur monté (rclone) sur /Users/julie/Mapli en 1.2 s'
    )
  })
})
