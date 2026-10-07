import type { MapliApi } from '@shared/bridge'
import type {
  DriveSettings,
  DriveState,
  EmployeeSpaceGroup,
  EmployeeSpaceNewFolder
} from '@shared/types'

/*
 * Accès au processus principal. Hors Electron (aperçu de l'interface dans un navigateur,
 * pour la mise au point), une maquette simule les états : ?etat=appairage, expire,
 * connecte, vide, plein, envoi, pause, hors-ligne, erreur, deconnecte, nouveau — et, pour
 * la petite fenêtre de l'espace salariés (adresse terminée par #popup) : popup-publier,
 * popup-dossier, popup-complet.
 */

const SPACE_GROUP: EmployeeSpaceGroup = {
  employee: {
    id: 'e1',
    name: 'Jean Dupont',
    email: 'jean.dupont@maison-verdier.fr',
    status: 'active'
  },
  category: { id: 'c1', name: 'Documents', slug: 'documents' },
  folder_id: 'f1',
  web_url: 'https://app.mapli.fr/documents?folder=f1',
  requests: [
    {
      id: 'r1',
      document_id: 'd1',
      name: 'Avenant 2026.pdf',
      size_bytes: 182_000,
      created_at: new Date().toISOString()
    },
    {
      id: 'r2',
      document_id: 'd2',
      name: 'Fiche de poste.pdf',
      size_bytes: 94_000,
      created_at: new Date().toISOString()
    }
  ],
  requested_at: new Date().toISOString()
}

const SPACE_FOLDER: EmployeeSpaceNewFolder = {
  id: 'f2',
  name: 'Nicolas BAAR',
  suggested: { first_name: 'Nicolas', last_name: 'BAAR' },
  created_at: new Date().toISOString(),
  web_url: 'https://app.mapli.fr/documents?folder=f2'
}

function mockSpace(scenario: string): Pick<DriveState, 'employeeSpace' | 'prompt'> {
  const seats = { used: 12, limit: 40, remaining: 28, can_create: true }
  switch (scenario) {
    case 'popup-publier':
      return {
        employeeSpace: { groups: [SPACE_GROUP], newFolders: [], seats },
        prompt: { kind: 'publish', group: SPACE_GROUP }
      }
    case 'popup-dossier':
      return {
        employeeSpace: { groups: [], newFolders: [SPACE_FOLDER], seats },
        prompt: { kind: 'folder', folder: SPACE_FOLDER, seats }
      }
    case 'popup-complet': {
      const full = { used: 40, limit: 40, remaining: 0, can_create: false }
      return {
        employeeSpace: { groups: [], newFolders: [SPACE_FOLDER], seats: full },
        prompt: { kind: 'folder', folder: SPACE_FOLDER, seats: full }
      }
    }
    default:
      return { employeeSpace: null, prompt: null }
  }
}

function mockState(): DriveState {
  const scenario = new URLSearchParams(window.location.search).get('etat') ?? 'connecte'
  const device = {
    organization: { id: 'org', name: 'Maison Verdier' },
    user: { first_name: 'Julie', last_name: 'Martin', email: 'julie@maison-verdier.fr' }
  }
  const base: DriveState = {
    phase: 'connected',
    pairing: null,
    device,
    mountPoint: 'M:',
    mounted: true,
    storage: {
      usedBytes: 13.3e9,
      limitBytes: 53.7e9,
      trashBytes: 1.2e9,
      memberUsedBytes: 0,
      memberLimitBytes: null
    },
    permissions: { view: true, upload: true, delete: true, manage_folders: true },
    transfers: [],
    pendingUploads: 0,
    recent: [
      {
        id: '1',
        name: 'Devis-Lenoir.pdf',
        folder: 'Clients',
        size_bytes: 248_000,
        mine: true,
        created_at: new Date(Date.now() - 4 * 60_000).toISOString()
      },
      {
        id: '2',
        name: 'Façade nord.jpg',
        folder: 'Chantier Grasse',
        size_bytes: 3_200_000,
        mine: false,
        created_at: new Date(Date.now() - 38 * 60_000).toISOString()
      },
      {
        id: '3',
        name: 'Planning chantier.xlsx',
        folder: 'Chantier Grasse',
        size_bytes: 61_000,
        mine: false,
        created_at: new Date(Date.now() - 2 * 3600_000).toISOString()
      },
      {
        id: '4',
        name: 'Compte rendu réunion.docx',
        folder: null,
        size_bytes: 34_000,
        mine: true,
        created_at: new Date(Date.now() - 5 * 3600_000).toISOString()
      },
      {
        id: '5',
        name: 'Présentation client.pptx',
        folder: 'Clients',
        size_bytes: 4_800_000,
        mine: true,
        created_at: new Date(Date.now() - 7 * 3600_000).toISOString()
      },
      {
        id: '6',
        name: 'Photos réception.zip',
        folder: null,
        size_bytes: 82_000_000,
        mine: true,
        created_at: new Date(Date.now() - 26 * 3600_000).toISOString()
      },
      {
        id: '7',
        name: 'Visite chantier.mp4',
        folder: 'Chantier Grasse',
        size_bytes: 148_000_000,
        mine: false,
        created_at: new Date(Date.now() - 50 * 3600_000).toISOString()
      },
      {
        id: '8',
        name: 'Message répondeur.m4a',
        folder: null,
        size_bytes: 920_000,
        mine: false,
        created_at: new Date(Date.now() - 74 * 3600_000).toISOString()
      }
    ],
    error: null,
    notice: null,
    ...mockSpace(scenario)
  }

  switch (scenario) {
    case 'nouveau':
      return {
        ...base,
        phase: 'unpaired',
        device: null,
        mounted: false,
        storage: null,
        permissions: null,
        recent: []
      }
    case 'appairage':
      return {
        ...base,
        phase: 'pairing',
        device: null,
        mounted: false,
        storage: null,
        recent: [],
        pairing: {
          code: 'MAPL-4F7K',
          url: 'https://app.mapli.fr/link-device?code=MAPL-4F7K',
          expiresAt: Date.now() + 14 * 60_000,
          status: 'waiting'
        }
      }
    case 'expire':
      return {
        ...base,
        phase: 'pairing',
        device: null,
        mounted: false,
        storage: null,
        recent: [],
        pairing: { code: 'MAPL-4F7K', url: '', expiresAt: Date.now(), status: 'expired' }
      }
    case 'envoi':
      return {
        ...base,
        pendingUploads: 2,
        transfers: [
          {
            name: 'Photos-chantier/IMG_2041.jpg',
            bytes: 2_400_000,
            size: 5_000_000,
            percentage: 48,
            speed: 1_200_000
          },
          { name: 'Planning.xlsx', bytes: 12_000, size: 61_000, percentage: 20, speed: 40_000 }
        ]
      }
    case 'plein':
      return {
        ...base,
        storage: { ...base.storage!, usedBytes: 52.1e9, limitBytes: 53.7e9 }
      }
    case 'vide':
      return { ...base, storage: { ...base.storage!, usedBytes: 0, trashBytes: 0 }, recent: [] }
    case 'pause':
      return { ...base, phase: 'paused', mounted: false }
    case 'hors-ligne':
      return {
        ...base,
        phase: 'offline',
        mounted: false,
        error: 'Mapli est injoignable. Vérifiez votre connexion internet.'
      }
    case 'erreur':
      return {
        ...base,
        phase: 'error',
        mounted: false,
        error:
          'Vous n’avez pas accès au coffre-fort de Maison Verdier. Demandez l’accès à un administrateur.'
      }
    case 'deconnecte':
      return {
        ...base,
        phase: 'unpaired',
        device: null,
        mounted: false,
        storage: null,
        recent: [],
        notice: 'Ce poste a été déconnecté de Mapli. Reliez-le pour retrouver le lecteur.'
      }
    default:
      return base
  }
}

function createMock(): MapliApi {
  let state = mockState()
  const listeners = new Set<(s: DriveState) => void>()
  const set = (partial: Partial<DriveState>) => {
    state = { ...state, ...partial }
    listeners.forEach((l) => l(state))
  }
  let settings: DriveSettings = { mountPoint: 'M:', autoStart: true, cacheSizeGb: 10 }
  const noop = async () => {}

  return {
    window: { minimize: () => {}, close: () => {} },
    info: async () => ({ version: '3.0.0', platform: 'win32', webUrl: 'https://app.mapli.fr' }),
    openLogs: noop,
    drive: {
      state: async () => state,
      onState: (callback) => {
        listeners.add(callback)
        return () => listeners.delete(callback)
      },
      startPairing: async () =>
        set({
          phase: 'pairing',
          pairing: {
            code: 'MAPL-4F7K',
            url: '',
            expiresAt: Date.now() + 15 * 60_000,
            status: 'waiting'
          }
        }),
      cancelPairing: async () => set({ phase: 'unpaired', pairing: null }),
      openVerification: noop,
      open: noop,
      openWeb: noop,
      pause: async () => set({ phase: 'paused', mounted: false }),
      resume: async () => set({ phase: 'connected', mounted: true, error: null }),
      unpair: async () => set({ phase: 'unpaired', device: null, mounted: false }),
      dismissNotice: async () => set({ notice: null })
    },
    space: {
      publish: async (_ids, notify) => {
        set({ prompt: null })
        return {
          ok: true,
          message: notify
            ? '2 documents publiés dans l’espace de Jean Dupont, prévenu par e-mail.'
            : '2 documents publiés dans l’espace de Jean Dupont.'
        }
      },
      discard: async () => {
        set({ prompt: null })
        return {
          ok: true,
          message: '2 documents ne seront pas publiés : ils restent classés dans le coffre.'
        }
      },
      createEmployee: async (_folderId, input) => {
        set({ prompt: null })
        return {
          ok: true,
          message: `Accès créé — un lien d'activation a été envoyé à ${input.email}.`
        }
      },
      keepFolder: async () => {
        set({ prompt: null })
        return { ok: true, message: '« Nicolas BAAR » reste un simple dossier.' }
      },
      later: async () => set({ prompt: null }),
      openWeb: noop,
      resize: () => {}
    },
    settings: {
      get: async () => settings,
      set: async (next) => (settings = { ...settings, ...next }),
      mountPoints: async () => ['D:', 'E:', 'M:', 'P:', 'Z:']
    },
    updater: {
      status: async () => ({ status: 'up-to-date' as const }),
      onStatus: () => () => {},
      check: noop,
      install: noop
    }
  }
}

export const mapli: MapliApi = window.mapli ?? createMock()
