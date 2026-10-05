/** Étape du lecteur, affichée par la fenêtre et l'icône de la zone de notification. */
export type DrivePhase =
  | 'unpaired' // poste non relié à Mapli
  | 'pairing' // code affiché, en attente d'approbation sur app.mapli.fr
  | 'connecting' // montage du lecteur en cours
  | 'connected' // lecteur monté
  | 'paused' // lecteur démonté à la demande
  | 'offline' // réseau ou serveur injoignable (nouvel essai automatique)
  | 'error' // accès refusé, outil manquant… (message dans `error`)

export interface PairingInfo {
  code: string
  url: string
  expiresAt: number
  status: 'waiting' | 'expired' | 'denied'
}

export interface DeviceInfo {
  organization: { id: string; name: string }
  user: { first_name: string; last_name: string; email: string }
}

export interface StorageInfo {
  usedBytes: number
  /** -1 = illimité */
  limitBytes: number
  trashBytes: number
  memberUsedBytes: number
  memberLimitBytes: number | null
}

export interface DrivePermissions {
  view: boolean
  upload: boolean
  delete: boolean
  manage_folders: boolean
}

/** Fichier en cours d'envoi ou de lecture (lecteur Windows). */
export interface Transfer {
  name: string
  bytes: number
  size: number
  percentage: number
  speed: number
}

export interface RecentFile {
  id: string
  name: string
  folder: string | null
  size_bytes: number
  mine: boolean
  created_at: string
}

export interface DriveState {
  phase: DrivePhase
  pairing: PairingInfo | null
  device: DeviceInfo | null
  /** Lettre (« M: ») sous Windows, chemin du volume sous macOS. */
  mountPoint: string
  mounted: boolean
  storage: StorageInfo | null
  permissions: DrivePermissions | null
  transfers: Transfer[]
  /** Envois en attente (écriture différée du lecteur). */
  pendingUploads: number
  recent: RecentFile[]
  error: string | null
  /** Message d'information ponctuel (ex. « Ce poste a été déconnecté depuis Mapli »). */
  notice: string | null
}

export interface DriveSettings {
  mountPoint: string
  autoStart: boolean
  /** Taille du cache local des fichiers ouverts (Go). */
  cacheSizeGb: number
}

export type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'

export interface AppInfo {
  version: string
  platform: string
  webUrl: string
}
