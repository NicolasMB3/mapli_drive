import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  AppInfo,
  DriveSettings,
  DriveState,
  NewEmployeeInput,
  SpaceResult,
  UpdateStatus
} from '../shared/types'
import type { MapliApi } from '../shared/bridge'
import {
  IPC_APP_INFO,
  IPC_DRIVE_CANCEL_PAIRING,
  IPC_DRIVE_DISMISS_NOTICE,
  IPC_DRIVE_OPEN,
  IPC_DRIVE_OPEN_VERIFICATION,
  IPC_DRIVE_OPEN_WEB,
  IPC_DRIVE_PAUSE,
  IPC_DRIVE_RESUME,
  IPC_DRIVE_START_PAIRING,
  IPC_DRIVE_STATE,
  IPC_DRIVE_STATE_CHANGED,
  IPC_DRIVE_UNPAIR,
  IPC_POPUP_RESIZE,
  IPC_SETTINGS_GET,
  IPC_SETTINGS_MOUNT_POINTS,
  IPC_SETTINGS_SET,
  IPC_SPACE_CREATE_EMPLOYEE,
  IPC_SPACE_DISCARD,
  IPC_SPACE_KEEP_FOLDER,
  IPC_SPACE_LATER,
  IPC_SPACE_OPEN_WEB,
  IPC_SPACE_PUBLISH,
  IPC_UPDATER_CHECK,
  IPC_UPDATER_INSTALL,
  IPC_UPDATER_STATUS,
  IPC_WINDOW_CLOSE,
  IPC_WINDOW_MINIMIZE
} from '../shared/ipc-channels'

/*
 * Pont entre la fenêtre (sans accès à Node) et le processus principal : une liste
 * fermée d'actions, aucun canal générique.
 */

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T): void => callback(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: MapliApi = {
  window: {
    minimize: () => ipcRenderer.send(IPC_WINDOW_MINIMIZE),
    close: () => ipcRenderer.send(IPC_WINDOW_CLOSE)
  },
  info: (): Promise<AppInfo> => ipcRenderer.invoke(IPC_APP_INFO),
  drive: {
    state: (): Promise<DriveState> => ipcRenderer.invoke(IPC_DRIVE_STATE),
    onState: (callback: (state: DriveState) => void) =>
      subscribe(IPC_DRIVE_STATE_CHANGED, callback),
    startPairing: (): Promise<void> => ipcRenderer.invoke(IPC_DRIVE_START_PAIRING),
    cancelPairing: (): Promise<void> => ipcRenderer.invoke(IPC_DRIVE_CANCEL_PAIRING),
    openVerification: (): Promise<void> => ipcRenderer.invoke(IPC_DRIVE_OPEN_VERIFICATION),
    open: (): Promise<void> => ipcRenderer.invoke(IPC_DRIVE_OPEN),
    openWeb: (page?: 'vault' | 'storage'): Promise<void> =>
      ipcRenderer.invoke(IPC_DRIVE_OPEN_WEB, page),
    pause: (): Promise<void> => ipcRenderer.invoke(IPC_DRIVE_PAUSE),
    resume: (): Promise<void> => ipcRenderer.invoke(IPC_DRIVE_RESUME),
    unpair: (): Promise<void> => ipcRenderer.invoke(IPC_DRIVE_UNPAIR),
    dismissNotice: (): Promise<void> => ipcRenderer.invoke(IPC_DRIVE_DISMISS_NOTICE)
  },
  space: {
    publish: (requestIds: string[], notify: boolean): Promise<SpaceResult> =>
      ipcRenderer.invoke(IPC_SPACE_PUBLISH, requestIds, notify),
    discard: (requestIds: string[]): Promise<SpaceResult> =>
      ipcRenderer.invoke(IPC_SPACE_DISCARD, requestIds),
    createEmployee: (folderId: string, input: NewEmployeeInput): Promise<SpaceResult> =>
      ipcRenderer.invoke(IPC_SPACE_CREATE_EMPLOYEE, folderId, input),
    keepFolder: (folderId: string): Promise<SpaceResult> =>
      ipcRenderer.invoke(IPC_SPACE_KEEP_FOLDER, folderId),
    later: (): Promise<void> => ipcRenderer.invoke(IPC_SPACE_LATER),
    openWeb: (url: string): Promise<void> => ipcRenderer.invoke(IPC_SPACE_OPEN_WEB, url),
    resize: (height: number) => ipcRenderer.send(IPC_POPUP_RESIZE, height)
  },
  settings: {
    get: (): Promise<DriveSettings> => ipcRenderer.invoke(IPC_SETTINGS_GET),
    set: (next: Partial<DriveSettings>): Promise<DriveSettings> =>
      ipcRenderer.invoke(IPC_SETTINGS_SET, next),
    mountPoints: (): Promise<string[]> => ipcRenderer.invoke(IPC_SETTINGS_MOUNT_POINTS)
  },
  updater: {
    status: (): Promise<{ status: UpdateStatus; version?: string }> =>
      ipcRenderer.invoke(IPC_UPDATER_STATUS),
    onStatus: (callback: (status: { status: UpdateStatus; version?: string }) => void) =>
      subscribe(IPC_UPDATER_STATUS, callback),
    check: (): Promise<void> => ipcRenderer.invoke(IPC_UPDATER_CHECK),
    install: (): Promise<void> => ipcRenderer.invoke(IPC_UPDATER_INSTALL)
  }
}

contextBridge.exposeInMainWorld('mapli', api)
