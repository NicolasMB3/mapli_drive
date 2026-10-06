import { describe, expect, it } from 'vitest'
import { rcloneMountArgs, rcloneMountEnv, type MountOptions } from '../rclone-args'

const options: MountOptions = {
  davUrl: 'https://app.mapli.fr/dav/',
  token: '42|secret-du-poste',
  mountPoint: 'M:',
  volumeName: 'Mapli',
  rcPort: 51234,
  rcUser: 'rc-user',
  rcPass: 'rc-pass-aleatoire',
  cacheDir: 'C:/Users/julie/AppData/Roaming/Mapli Drive/cache',
  cacheSizeGb: 10,
  logFile: 'C:/Users/julie/AppData/Roaming/Mapli Drive/rclone.log',
  configFile: 'C:/Users/julie/AppData/Roaming/Mapli Drive/rclone.conf',
  userAgent: 'MapliDrive/3.0.0'
}

describe('montage rclone', () => {
  it('never puts secrets on the command line', () => {
    const args = rcloneMountArgs(options).join(' ')
    expect(args).not.toContain(options.token)
    expect(args).not.toContain(options.rcPass)
    expect(args).not.toContain('--rc-no-auth')
  })

  it('keeps TLS verification on', () => {
    expect(rcloneMountArgs(options)).not.toContain('--no-check-certificate')
  })

  it('binds the control port to the loopback interface only', () => {
    const args = rcloneMountArgs(options)
    expect(args[args.indexOf('--rc-addr') + 1]).toBe('127.0.0.1:51234')
  })

  it('passes the token, the control credentials and an isolated config through the environment', () => {
    const env = rcloneMountEnv(options, {})
    expect(env).toMatchObject({
      RCLONE_WEBDAV_URL: 'https://app.mapli.fr/dav/',
      RCLONE_WEBDAV_VENDOR: 'owncloud',
      RCLONE_WEBDAV_BEARER_TOKEN: '42|secret-du-poste',
      RCLONE_RC_USER: 'rc-user',
      RCLONE_RC_PASS: 'rc-pass-aleatoire',
      RCLONE_CONFIG: options.configFile
    })
  })

  it('mounts the drive under the chosen letter with the Mapli volume name and a full cache', () => {
    const args = rcloneMountArgs(options)
    expect(args.slice(0, 3)).toEqual(['mount', ':webdav:', 'M:'])
    expect(args[args.indexOf('--volname') + 1]).toBe('Mapli')
    expect(args[args.indexOf('--vfs-cache-mode') + 1]).toBe('full')
    expect(args[args.indexOf('--vfs-cache-max-size') + 1]).toBe('10G')
  })

  it('keeps folder listings 10 minutes: changes made elsewhere are pushed and forgotten folder by folder', () => {
    const args = rcloneMountArgs(options)
    expect(args[args.indexOf('--dir-cache-time') + 1]).toBe('10m')
  })

  it('logs warnings and errors only', () => {
    const args = rcloneMountArgs(options)
    expect(args[args.indexOf('--log-level') + 1]).toBe('NOTICE')
  })
})
