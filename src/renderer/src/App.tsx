import { useEffect, useState } from 'react'
import type { AppInfo, DriveState } from '@shared/types'
import { Titlebar } from './components/Titlebar'
import { PairingScreen } from './components/PairingScreen'
import { DriveScreen } from './components/DriveScreen'
import { SettingsScreen } from './components/SettingsScreen'
import { mapli } from './lib/bridge'

/** Fenêtre de Mapli Drive : appairage tant que le poste n'est pas relié, sinon le lecteur (ou ses réglages). */
export default function App() {
  const [state, setState] = useState<DriveState | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [view, setView] = useState<'drive' | 'settings'>('drive')

  useEffect(() => {
    void mapli.info().then(setInfo)
    void mapli.drive.state().then(setState)
    return mapli.drive.onState(setState)
  }, [])

  if (!state) return <div className="h-full bg-ink" />

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
