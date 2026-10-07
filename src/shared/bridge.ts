import type {
  AppInfo,
  DriveSettings,
  DriveState,
  NewEmployeeInput,
  SpaceResult,
  UpdateStatus
} from './types'

/** Ce que la fenêtre peut demander au processus principal (exposé par le preload sous `window.mapli`). */
export interface MapliApi {
  window: {
    minimize: () => void
    close: () => void
  }
  info: () => Promise<AppInfo>
  /** Le dossier du journal de l'application (à joindre à une demande d'assistance). */
  openLogs: () => Promise<void>
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
  /** Espace salariés : la petite fenêtre (publier, créer l'espace d'une personne). */
  space: {
    publish: (requestIds: string[], notify: boolean) => Promise<SpaceResult>
    discard: (requestIds: string[]) => Promise<SpaceResult>
    createEmployee: (folderId: string, input: NewEmployeeInput) => Promise<SpaceResult>
    keepFolder: (folderId: string) => Promise<SpaceResult>
    /** « Plus tard » : la fenêtre passe à la suite, ou se cache. */
    later: () => Promise<void>
    /** Le dossier sur app.mapli.fr (adresses de Mapli seulement). */
    openWeb: (url: string) => Promise<void>
    /** La fenêtre s'ajuste à la hauteur de son contenu. */
    resize: (height: number) => void
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
