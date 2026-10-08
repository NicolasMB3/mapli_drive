import { useEffect, useState } from 'react'
import type { AppInfo, DriveState } from '@shared/types'
import { Titlebar } from './components/Titlebar'
import { PairingScreen } from './components/PairingScreen'
import { DriveScreen } from './components/DriveScreen'
import { SettingsScreen } from './components/SettingsScreen'
import { EmployeeSpacePopup } from './components/EmployeeSpacePopup'
import { MapliLoader } from './components/Brand'
import { mapli } from './lib/bridge'

/**
 * Fenêtres de Mapli Drive : la fenêtre principale (appairage tant que le poste n'est pas
 * relié, sinon le lecteur ou ses réglages), et la petite fenêtre de l'espace salariés (#popup).
 */
export default function App() {
  return window.location.hash === '#popup' ? <EmployeeSpacePopup /> : <MainWindow />
}

function MainWindow() {
  const [state, setState] = useState<DriveState | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [view, setView] = useState<'drive' | 'settings'>('drive')

  useEffect(() => {
    void mapli.info().then(setInfo)
    void mapli.drive.state().then(setState)
    return mapli.drive.onState(setState)
  }, [])

  // Le temps que le processus principal donne l'état : le chargement de la marque, s'il dure.
  if (!state)
    return (
      <div className="grid h-full place-items-center bg-ink">
        <MapliLoader tone="sombre" size={64} delayed />
      </div>
    )

  const paired = state.device !== null && state.phase !== 'unpaired' && state.phase !== 'pairing'

  return (
    <div className="flex h-full flex-col bg-surface">
      <Titlebar
        onSettings={paired ? () => setView(view === 'settings' ? 'drive' : 'settings') : undefined}
        settingsOpen={view === 'settings'}
      />
      {!paired ? (
        <PairingScreen state={state} />
      ) : view === 'settings' ? (
        <SettingsScreen state={state} info={info} onBack={() => setView('drive')} />
      ) : (
        <DriveScreen state={state} info={info} onSettings={() => setView('settings')} />
      )}
    </div>
  )
}
