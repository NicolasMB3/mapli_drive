import type { AppInfo, DriveSettings, DriveState, UpdateStatus } from './types'

/** Ce que la fenêtre peut demander au processus principal (exposé par le preload sous `window.mapli`). */
export interface MapliApi {
  window: {
    minimize: () => void
    close: () => void
  }
  info: () => Promise<AppInfo>
  drive: {
    state: () => Promise<DriveState>
    onState: (callback: (state: DriveState) => void) => () => void
    startPairing: () => Promise<void>
    cancelPairing: () => Promise<void>
    openVerification: () => Promise<void>
    open: () => Promise<void>
    /** Le coffre-fort sur le web (« vault »), ou la page de son espace (« storage »). */
    openWeb: (page?: 'vault' | 'storage') => Promise<void>
    pause: () => Promise<void>
    resume: () => Promise<void>
    unpair: () => Promise<void>
    dismissNotice: () => Promise<void>
  }
  settings: {
    get: () => Promise<DriveSettings>
    set: (next: Partial<DriveSettings>) => Promise<DriveSettings>
    mountPoints: () => Promise<string[]>
  }
  updater: {
    status: () => Promise<{ status: UpdateStatus; version?: string }>
    onStatus: (callback: (status: { status: UpdateStatus; version?: string }) => void) => () => void
    check: () => Promise<void>
    install: () => Promise<void>
  }
}
