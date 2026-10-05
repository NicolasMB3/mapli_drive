import { Minus, Settings, X } from 'lucide-react'
import { MapliMark } from './Art'
import { mapli } from '../lib/bridge'
import { cn } from '../lib/cn'

/**
 * Barre de titre (fenêtre sans cadre), charte « Papier » : à l'encre, dans le
 * prolongement du bandeau, coiffée du filet violet du Coffre-fort — le M de Mapli, le
 * nom, puis les réglages et les boutons de la fenêtre.
 */
export function Titlebar({ onSettings, settingsOpen }: { onSettings?: () => void; settingsOpen?: boolean }) {
  const button =
    'no-drag grid h-[34px] w-10 cursor-pointer place-items-center text-white/55 transition-colors hover:bg-white/10 hover:text-white'
  return (
    <div className="drag relative flex h-[34px] shrink-0 items-center justify-between border-b border-white/10 bg-ink pl-3.5 text-white">
      <span aria-hidden="true" className="absolute inset-x-0 top-0 h-[2px] bg-coffre" />
      <span className="flex items-center gap-2.5">
        <MapliMark className="h-[11px] w-auto" />
        <span className="text-[12px] font-medium tracking-[-0.01em]">Mapli Drive</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-white/40">Coffre-fort</span>
      </span>
      <div className="flex">
        {onSettings && (
          <button
            type="button"
            onClick={onSettings}
            className={cn(button, settingsOpen && 'bg-white/10 text-white')}
            title="Réglages"
            aria-label="Réglages"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        )}
        <button type="button" onClick={() => mapli.window.minimize()} className={button} title="Réduire" aria-label="Réduire">
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => mapli.window.close()}
          className={cn(button, 'hover:bg-danger hover:text-white')}
          title="Fermer (Mapli Drive reste actif)"
          aria-label="Fermer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
