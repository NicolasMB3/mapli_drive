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

/** Espace salariés : documents déposés par la personne dans le dossier d'un salarié, à valider. */
export interface EmployeeSpaceGroup {
  employee: { id: string; name: string; email: string; status: string } | null
  category: { id: string; name: string; slug: string } | null
  folder_id: string | null
  /** Le dossier sur app.mapli.fr. */
  web_url: string
  requests: {
    id: string
    document_id: string
    name: string
    size_bytes: number
    created_at: string
  }[]
  requested_at: string | null
}

/** Dossier créé à la main dans « Espace salariés » (« Nicolas BAAR ») : créer l'espace de la personne ? */
export interface EmployeeSpaceNewFolder {
  id: string
  name: string
  suggested: { first_name: string; last_name: string }
  created_at: string | null
  web_url: string
}

/** Places de l'offre pour l'espace salarié (-1 : illimité, 0 : non inclus). */
export interface EmployeeSpaceSeats {
  used: number
  limit: number
  remaining: number | null
  can_create: boolean
}

export interface EmployeeSpaceState {
  groups: EmployeeSpaceGroup[]
  newFolders: EmployeeSpaceNewFolder[]
  seats: EmployeeSpaceSeats | null
}

/** Ce que la petite fenêtre propose maintenant. */
export type EmployeeSpacePrompt =
  | { kind: 'publish'; group: EmployeeSpaceGroup }
  | { kind: 'folder'; folder: EmployeeSpaceNewFolder; seats: EmployeeSpaceSeats | null }

/** Fiche de la personne dont on ouvre l'espace salarié (adresse facultative). */
export interface NewEmployeeInput {
  first_name: string
  last_name: string
  email: string
  phone?: string
  address?: { line1: string; postal_code: string; city: string }
}

/** Réponse d'une action de la petite fenêtre (le message à afficher). */
export interface SpaceResult {
  ok: boolean
  message: string
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
  /** Espace salariés (pour qui le gère) : ce qui attend une validation ; null sinon. */
  employeeSpace: EmployeeSpaceState | null
  /** Ce que la petite fenêtre propose maintenant (null : rien, elle se cache). */
  prompt: EmployeeSpacePrompt | null
}

export interface DriveSettings {
  mountPoint: string
  autoStart: boolean
  /** Taille du cache local des fichiers ouverts (Go). */
  cacheSizeGb: number
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

export interface AppInfo {
  version: string
  platform: string
  webUrl: string
}
