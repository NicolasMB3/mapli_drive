import type { MapliApi } from '@shared/bridge'

declare global {
  interface Window {
    /** Pont vers le processus principal (absent en aperçu navigateur : voir lib/bridge.ts). */
    mapli?: MapliApi
  }
}

export {}
