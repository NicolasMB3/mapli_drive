import { Minus, Settings, X } from 'lucide-react'
import { MapliMark } from './Art'
import { mapli } from '../lib/bridge'
import { cn } from '../lib/cn'

/**
 * Barre de titre (fenêtre sans cadre), charte « Papier », comme la barre du haut de
 * app.mapli.fr : des cases à filets — le M de Mapli, le nom et la pastille du
 * Coffre-fort, les réglages, la réduction — et la fermeture à l'encre.
 */
export function Titlebar({
  onSettings,
  settingsOpen
}: {
  onSettings?: () => void
  settingsOpen?: boolean
}) {
  const cell =
    'no-drag relative grid w-10 cursor-pointer place-items-center border-l border-line text-muted transition-colors hover:bg-surface-dim hover:text-ink'
  return (
    <div className="drag flex h-9 shrink-0 items-stretch border-b border-line bg-surface">
      <span className="grid w-11 shrink-0 place-items-center border-r border-line">
        <MapliMark className="h-[10px] w-auto" />
      </span>
      <span className="flex min-w-0 items-center gap-2 px-3">
        <span className="truncate text-[12px] font-medium tracking-[-0.01em] text-ink">
          Mapli Drive
        </span>
        <span className="inline-flex h-5 shrink-0 items-center gap-[5px] rounded-[3px] border border-line px-[7px] text-[11px] text-ink">
          <span className="h-1.5 w-1.5 rounded-[1px] bg-coffre" />
          Coffre-fort
        </span>
      </span>
      <div className="ml-auto flex">
        {onSettings && (
          <button
            type="button"
            onClick={onSettings}
            className={cn(
              cell,
              settingsOpen &&
                'bg-surface-dim text-ink after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-coffre'
            )}
            title="Réglages"
            aria-label="Réglages"
            aria-pressed={settingsOpen}
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={() => mapli.window.minimize()}
          className={cell}
          title="Réduire"
          aria-label="Réduire"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => mapli.window.close()}
          className="no-drag grid w-10 cursor-pointer place-items-center bg-ink text-white transition-colors hover:bg-danger"
          title="Fermer (Mapli Drive reste actif)"
          aria-label="Fermer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
