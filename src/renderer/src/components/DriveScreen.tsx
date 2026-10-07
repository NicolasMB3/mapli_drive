import {
  ArrowUpRight,
  ExternalLink,
  Folder,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  Settings
} from 'lucide-react'
import type { AppInfo, DriveState } from '@shared/types'
import { CoffreCloseUp } from './Art'
import { DropIllustration, FileSheet } from './FileArt'
import { mapli } from '../lib/bridge'
import { cn } from '../lib/cn'
import { baseName, formatBytes, formatRelative, plural } from '../lib/format'

/*
 * Le lecteur (direction « Bandeau ») : bandeau d'encre (organisation, lecteur, état)
 * prolongé du gros plan violet, le bouton d'encre pour ouvrir le lecteur, la jauge
 * d'espace, puis ce qui se passe (envois en cours, fichiers récemment ajoutés), chaque
 * fichier dessiné en feuille selon son type.
 */

const kicker = 'font-mono text-[11px] uppercase tracking-[0.06em]'

function status(state: DriveState): { label: string; tone: string } {
  // Les envois en attente comprennent ceux en cours : on garde le plus grand des deux.
  const uploads = Math.max(state.transfers.length, state.pendingUploads)
  switch (state.phase) {
    case 'connected':
      return uploads > 0
        ? { label: `Envoi en cours · ${plural(uploads, 'fichier')}`, tone: 'bg-courrier' }
        : { label: 'Connecté · tout est à jour', tone: 'bg-success' }
    case 'connecting':
      return { label: 'Connexion du lecteur…', tone: 'bg-courrier' }
    case 'paused':
      return { label: 'En pause · lecteur retiré', tone: 'bg-courrier' }
    case 'offline':
      return { label: 'Hors ligne · reconnexion…', tone: 'bg-danger' }
    default:
      return { label: 'Action requise', tone: 'bg-danger' }
  }
}

export function DriveScreen({
  state,
  info,
  onSettings
}: {
  state: DriveState
  info: AppInfo | null
  onSettings: () => void
}) {
  const isMac = info?.platform === 'darwin'
  const driveLabel = isMac ? 'Lecteur Mapli' : `Lecteur ${state.mountPoint}`
  const { label, tone } = status(state)
  const storage = state.storage
  const limited = storage && storage.limitBytes > 0
  const percent = limited
    ? Math.min(100, Math.round((storage.usedBytes / storage.limitBytes) * 100))
    : 0

  const primary =
    state.phase === 'connected'
      ? {
          text: isMac ? 'Ouvrir dans le Finder' : `Ouvrir le lecteur ${state.mountPoint}`,
          icon: <ExternalLink className="h-4 w-4" />,
          onClick: () => mapli.drive.open()
        }
      : state.phase === 'paused'
        ? {
            text: 'Reprendre',
            icon: <Play className="h-4 w-4" />,
            onClick: () => mapli.drive.resume()
          }
        : state.phase === 'connecting'
          ? {
              text: 'Connexion…',
              icon: <Loader2 className="h-4 w-4 animate-spin" />,
              onClick: undefined
            }
          : {
              text: 'Réessayer',
              icon: <RotateCcw className="h-4 w-4" />,
              onClick: () => mapli.drive.resume()
            }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Bandeau d'encre et gros plan */}
      <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_112px]">
        <div className="min-w-0 bg-ink px-4 pb-4 pt-[18px] text-white">
          <p className={`${kicker} flex min-w-0 items-center gap-2 text-white/60`}>
            <span className="h-[7px] w-[7px] shrink-0 rounded-[1px] bg-coffre" />
            <span className="truncate">{state.device?.organization.name}</span>
          </p>
          <h1 className="mt-2 truncate text-[30px] font-medium leading-none tracking-[-0.04em]">
            {driveLabel}
          </h1>
          <p className="mt-2.5 flex items-center gap-2 text-[12px] text-white/75">
            <span className={cn('h-[7px] w-[7px] shrink-0 rounded-[1px]', tone)} />
            {label}
          </p>
        </div>
        <div className="relative overflow-hidden bg-coffre">
          <CoffreCloseUp align="xMinYMid" className="absolute inset-0 h-full w-full" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-4 [scrollbar-width:thin]">
        {state.notice && state.phase === 'connected' && (
          <div className="mb-3 border border-l-[3px] border-[#F0C9C3] border-l-danger bg-danger-tint px-3 py-2.5">
            <div className="flex items-start justify-between gap-2">
              <p className={`${kicker} text-danger`}>Envoi impossible</p>
              <button
                type="button"
                onClick={() => void mapli.drive.dismissNotice()}
                className="-mr-1 -mt-0.5 cursor-pointer px-1 text-[12px] text-muted hover:text-ink"
                aria-label="Fermer"
              >
                ✕
              </button>
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-body">{state.notice}</p>
          </div>
        )}

        {state.error && (state.phase === 'error' || state.phase === 'offline') && (
          <div className="mb-3 border border-l-[3px] border-[#F0C9C3] border-l-danger bg-danger-tint px-3 py-2.5">
            <p className={`${kicker} text-danger`}>
              {state.phase === 'offline' ? 'Hors ligne' : 'Accès au lecteur'}
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-body">{state.error}</p>
          </div>
        )}

        <button
          type="button"
          onClick={primary.onClick}
          disabled={!primary.onClick}
          className="flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-[4px] bg-ink text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-80"
        >
          {primary.icon}
          {primary.text}
        </button>

        <div className="mt-2 flex items-center justify-between text-[12px]">
          <button
            type="button"
            onClick={() => mapli.drive.openWeb()}
            className="flex cursor-pointer items-center gap-1 text-ink underline decoration-ink/25 underline-offset-[3px] hover:decoration-ink"
          >
            Coffre-fort sur le web <ArrowUpRight className="h-3 w-3" />
          </button>
          {state.phase === 'connected' && (
            <button
              type="button"
              onClick={() => mapli.drive.pause()}
              className="flex cursor-pointer items-center gap-1 text-muted hover:text-ink"
            >
              <Pause className="h-3 w-3" /> Mettre en pause
            </button>
          )}
        </div>

        {/* Espace */}
        {storage && (
          <div className="mt-5">
            <div className="flex items-baseline justify-between gap-3">
              <span className={`${kicker} text-ink`}>Espace</span>
              <span className="text-[12px] tabular-nums">
                <span className="font-medium">{formatBytes(storage.usedBytes)}</span>
                <span className="text-muted">
                  {limited ? ` sur ${formatBytes(storage.limitBytes)}` : ' · illimité'}
                </span>
              </span>
            </div>
            <div className="mt-2 h-1 bg-line">
              <div
                className={cn(
                  'h-full transition-[width] duration-500',
                  percent > 80 ? 'bg-warning' : 'bg-coffre'
                )}
                style={{ width: `${limited ? percent : 4}%` }}
              />
            </div>
            {storage.trashBytes > 0 && (
              <p className="mt-1.5 text-[11px] text-muted">
                dont {formatBytes(storage.trashBytes)} dans la corbeille (vidée après 30 jours)
              </p>
            )}
            {storage.memberLimitBytes !== null && (
              <p className="mt-1 text-[11px] text-muted">
                Votre limite : {formatBytes(storage.memberUsedBytes)} sur{' '}
                {formatBytes(storage.memberLimitBytes)}
              </p>
            )}
            {limited && percent >= 80 && (
              <button
                type="button"
                onClick={() => mapli.drive.openWeb('storage')}
                className="mt-1.5 flex cursor-pointer items-center gap-1 text-[12px] font-medium text-ink underline decoration-ink/25 underline-offset-[3px] hover:decoration-ink"
              >
                {percent >= 100 ? 'Coffre plein : augmenter l’espace' : 'Augmenter l’espace'}{' '}
                <ArrowUpRight className="h-3 w-3" />
              </button>
            )}
          </div>
        )}

        {state.permissions && !state.permissions.upload && (
          <p className="mt-4 border-y border-line py-2 text-[12px] text-muted">
            Lecture seule : vous pouvez ouvrir les documents du coffre, pas en ajouter.
          </p>
        )}

        {/* Envois en cours */}
        {(state.transfers.length > 0 || state.pendingUploads > 0) && (
          <section className="mt-5">
            <p className={`${kicker} mb-1.5 text-muted`}>En cours</p>
            {state.transfers.map((t) => (
              <div key={t.name} className="flex items-center gap-3 border-t border-line py-2">
                <FileSheet name={t.name} uploading className="shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink" title={t.name}>
                    {baseName(t.name)}
                  </span>
                  <span className="mt-1.5 block h-[3px] bg-line">
                    <span
                      className="block h-full bg-coffre transition-[width] duration-500"
                      style={{ width: `${t.percentage}%` }}
                    />
                  </span>
                </span>
                <span className="w-9 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted">
                  {t.percentage} %
                </span>
              </div>
            ))}
            {state.transfers.length === 0 && state.pendingUploads > 0 && (
              <p className="border-t border-line py-2 text-[12px] text-muted">
                {plural(state.pendingUploads, 'envoi')} en attente…
              </p>
            )}
          </section>
        )}

        {/* Récemment ajoutés */}
        {state.phase !== 'error' && (
          <section className="mt-5">
            <p className={`${kicker} mb-1.5 text-muted`}>Récemment ajoutés</p>
            {state.recent.length === 0 ? (
              <div className="flex items-center gap-3.5 border-y border-line py-3">
                <DropIllustration className="h-14 w-auto shrink-0" />
                <p className="text-[12px] leading-relaxed text-muted">
                  Glissez des fichiers ou des dossiers dans le{' '}
                  {isMac ? 'volume Mapli' : `lecteur ${state.mountPoint}`} : ils arrivent dans le
                  coffre-fort, chiffrés.
                </p>
              </div>
            ) : (
              state.recent.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-3 border-t border-line py-2 last:border-b"
                >
                  <FileSheet name={f.name} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink" title={f.name}>
                      {f.name}
                    </span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-muted">
                      {f.folder && (
                        <>
                          <Folder className="h-2.5 w-2.5 shrink-0" />
                          <span className="truncate">{f.folder}</span>
                          <span aria-hidden="true">·</span>
                        </>
                      )}
                      <span className="shrink-0">{formatBytes(f.size_bytes)}</span>
                    </span>
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted">
                    {formatRelative(f.created_at)}
                  </span>
                </div>
              ))
            )}
          </section>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-between border-t border-line bg-surface-dim px-4 py-2 text-[12px]">
        <span className="font-mono text-[11px] tracking-[0.04em] text-muted">
          v{info?.version ?? '…'}
        </span>
        <button
          type="button"
          onClick={onSettings}
          className="flex cursor-pointer items-center gap-1.5 text-ink hover:opacity-70"
        >
          <Settings className="h-3.5 w-3.5" />
          Réglages
        </button>
      </div>
    </div>
  )
}
