import Store from 'electron-store'
import { safeStorage } from 'electron'
import type { DeviceInfo, DriveSettings } from '../shared/types'
import { defaultMountPoint } from './platform'

/*
 * Ce que le poste garde entre deux lancements : le token d'appareil (chiffré par le
 * système — DPAPI sous Windows, trousseau sous macOS — jamais en clair sur le disque),
 * l'organisation et l'utilisateur, et les réglages du lecteur. Aucun mot de passe.
 */

interface StoredDevice extends DeviceInfo {
  token: string // chiffré (safeStorage), en base64
  pairedAt: string
}

interface Schema {
  device?: StoredDevice
  settings?: Partial<DriveSettings>
  launched?: boolean
}

const store = new Store<Schema>({ name: 'mapli-drive' })

export interface Device extends DeviceInfo {
  token: string
}

export function loadDevice(): Device | null {
  const device = store.get('device')
  if (!device?.token) return null

  try {
    const token = safeStorage.decryptString(Buffer.from(device.token, 'base64'))
    return { token, organization: device.organization, user: device.user }
  } catch {
    // Profil Windows/macOS changé, clé système perdue : le poste devra être relié à nouveau.
    store.delete('device')
    return null
  }
}

export function saveDevice(device: Device): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Le chiffrement du système est indisponible : impossible de garder la connexion de ce poste.')
  }

  store.set('device', {
    token: safeStorage.encryptString(device.token).toString('base64'),
    organization: device.organization,
    user: device.user,
    pairedAt: new Date().toISOString(),
  })
}

export function updateDeviceContext(context: DeviceInfo): void {
  const device = store.get('device')
  if (device) store.set('device', { ...device, organization: context.organization, user: context.user })
}

export function clearDevice(): void {
  store.delete('device')
}

export function loadSettings(): DriveSettings {
  const saved = store.get('settings') ?? {}
  return {
    mountPoint: saved.mountPoint || defaultMountPoint(),
    autoStart: saved.autoStart ?? true,
    cacheSizeGb: saved.cacheSizeGb ?? 10,
  }
}

export function saveSettings(settings: Partial<DriveSettings>): DriveSettings {
  const next = { ...loadSettings(), ...settings }
  store.set('settings', next)
  return next
}

export function isFirstLaunch(): boolean {
  return !store.get('launched')
}

export function markLaunched(): void {
  store.set('launched', true)
}
