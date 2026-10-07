import { describe, expect, it } from 'vitest'
import {
  CACHE_MIN_FREE_SPACE,
  NFS_DEAD_TIMEOUT_S,
  rcloneMountArgs,
  rcloneMountEnv,
  rcloneNfsMountArgs,
  rcloneProxy,
  rcloneVfsArgs,
  type MountOptions
} from '../rclone-args'

const options: MountOptions = {
  davUrl: 'https://app.mapli.fr/dav/',
  token: '42|secret-du-poste',
  mountPoint: 'M:',
  volumeName: 'Mapli',
  rcPort: 51234,
  rcUser: 'rc-user',
  rcPass: 'rc-pass-aleatoire',
  cacheDir: 'C:/Users/julie/AppData/Local/Mapli Drive/cache',
  cacheSizeGb: 10,
  logFile: 'C:/Users/julie/AppData/Roaming/Mapli Drive/rclone.log',
  configFile: 'C:/Users/julie/AppData/Roaming/Mapli Drive/rclone.conf',
  userAgent: 'MapliDrive/3.0.0'
}

/** Valeur qui suit un drapeau (undefined s'il est absent). */
function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
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
    expect(flag(rcloneMountArgs(options), '--rc-addr')).toBe('127.0.0.1:51234')
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
    expect(flag(args, '--volname')).toBe('Mapli')
    expect(flag(args, '--vfs-cache-mode')).toBe('full')
    expect(flag(args, '--vfs-cache-max-size')).toBe('10G')
  })

  it('shares the cache, network and logging settings with the macOS mount', () => {
    const args = rcloneMountArgs(options)
    const shared = rcloneVfsArgs(options)
    expect(args.slice(-shared.length)).toEqual(shared)
    expect(shared).not.toContain('--volname')
  })

  it('never fills the system disk: uncached space is kept free', () => {
    expect(flag(rcloneMountArgs(options), '--vfs-cache-min-free-space')).toBe(CACHE_MIN_FREE_SPACE)
  })

  it('relies on per-request retries only (--retries does nothing for a mount)', () => {
    const args = rcloneMountArgs(options)
    expect(args).not.toContain('--retries')
    expect(flag(args, '--low-level-retries')).toBe('10')
  })

  it('keeps folder listings 10 minutes: changes made elsewhere are pushed and forgotten folder by folder', () => {
    expect(flag(rcloneMountArgs(options), '--dir-cache-time')).toBe('10m')
  })

  it('logs warnings and errors only, without rclone’s own rotation (it would drop WinFsp messages)', () => {
    const args = rcloneMountArgs(options)
    expect(flag(args, '--log-level')).toBe('NOTICE')
    expect(args.some((arg) => arg.startsWith('--log-file-max'))).toBe(false)
  })
})

describe('proxy du poste pour rclone', () => {
  it('uses the proxy resolved for the API, whatever was inherited', () => {
    const env = rcloneMountEnv(
      { ...options, proxy: 'http://proxy.entreprise.fr:3128' },
      { https_proxy: 'http://ancien:8080', NO_PROXY: 'app.mapli.fr', PATH: 'C:/Windows' }
    )
    expect(env.HTTPS_PROXY).toBe('http://proxy.entreprise.fr:3128')
    expect(env.HTTP_PROXY).toBe('http://proxy.entreprise.fr:3128')
    expect(env.https_proxy).toBeUndefined()
    expect(env.NO_PROXY).toBeUndefined()
    expect(env.PATH).toBe('C:/Windows')
  })

  it('goes direct when the system says so, dropping inherited proxy variables', () => {
    const env = rcloneMountEnv(
      { ...options, proxy: null },
      { HTTPS_PROXY: 'http://ancien:8080', all_proxy: 'socks5://x:1080' }
    )
    expect(Object.keys(env).filter((key) => /_proxy$/i.test(key))).toEqual([])
  })

  it('leaves the inherited environment alone when no proxy was resolved', () => {
    const env = rcloneMountEnv(options, { HTTPS_PROXY: 'http://hérité:8080' })
    expect(env.HTTPS_PROXY).toBe('http://hérité:8080')
  })

  it('turns Chromium’s answer into a URL for Go: the first entry, direct meaning none', () => {
    expect(rcloneProxy([{ kind: 'http', host: 'proxy.local', port: 8080 }])).toBe(
      'http://proxy.local:8080'
    )
    expect(
      rcloneProxy([{ kind: 'https', host: 'secure.proxy', port: 443 }, { kind: 'direct' }])
    ).toBe('https://secure.proxy:443')
    expect(rcloneProxy([{ kind: 'http', host: '::1', port: 3128 }])).toBe('http://[::1]:3128')
    expect(rcloneProxy([{ kind: 'direct' }, { kind: 'http', host: 'p', port: 1 }])).toBeNull()
    expect(rcloneProxy([])).toBeNull()
  })
})

describe('montage rclone NFS (macOS)', () => {
  const mac: MountOptions = {
    ...options,
    mountPoint: '/Users/julie/Library/Application Support/mapli-drive/Mapli',
    cacheDir: '/Users/julie/Library/Caches/fr.mapli.drive/rclone',
    logFile: '/Users/julie/Library/Application Support/mapli-drive/rclone.log',
    configFile: '/Users/julie/Library/Application Support/mapli-drive/rclone.conf'
  }
  const args = rcloneNfsMountArgs(mac)
  const mountOptions = args.flatMap((arg, i) => (arg === '-o' ? [args[i + 1]] : []))

  it('serves the vault over NFS on IPv4 loopback, mounted in the drive folder', () => {
    expect(args.slice(0, 3)).toEqual(['nfsmount', ':webdav:', mac.mountPoint])
    expect(flag(args, '--addr')).toBe('127.0.0.1:0')
  })

  it('never waits for NLM or RQUOTA, never freezes the Finder, sends composed names', () => {
    expect(mountOptions).toEqual([
      'locallocks',
      'noquota',
      'intr',
      `deadtimeout=${NFS_DEAD_TIMEOUT_S}`,
      'nfc'
    ])
  })

  it('shares the cache, network and logging settings with the Windows mount', () => {
    expect(args.slice(-rcloneVfsArgs(mac).length)).toEqual(rcloneVfsArgs(mac))
    expect(flag(args, '--vfs-write-back')).toBe('3s')
    expect(flag(args, '--cache-dir')).toBe(mac.cacheDir)
    expect(flag(args, '--rc-addr')).toBe('127.0.0.1:51234')
  })

  it('never puts secrets on the command line', () => {
    const line = args.join(' ')
    expect(line).not.toContain(mac.token)
    expect(line).not.toContain(mac.rcPass)
    expect(line).not.toContain('--rc-no-auth')
    expect(line).not.toContain('--no-check-certificate')
  })
})
