import { useEffect, useState } from 'react'
import { ExternalLink, Loader2, Lock, RotateCcw } from 'lucide-react'
import type { DriveState } from '@shared/types'
import { CoffreCloseUp } from './Art'
import { mapli } from '../lib/bridge'

/*
 * Relier le poste (direction « Bandeau ») : un bandeau d'encre, le code MAPL-XXXX sur
 * une plaque blanche, l'approbation sur app.mapli.fr, le gros plan violet en pied.
 */

const kicker = 'font-mono text-[11px] uppercase tracking-[0.06em]'
const whiteButton =
  'flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-[4px] bg-white text-[13px] font-medium text-ink transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60'

function useCountdown(until: number | undefined): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!until) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [until])
  if (!until) return ''
  const seconds = Math.max(0, Math.round((until - now) / 1000))
  const minutes = Math.ceil(seconds / 60)
  return seconds > 60 ? `Expire dans ${minutes} min` : `Expire dans ${seconds} s`
}

export function PairingScreen({ state }: { state: DriveState }) {
  const [busy, setBusy] = useState(false)
  const pairing = state.pairing
  const waiting = state.phase === 'pairing' && pairing?.status === 'waiting'
  const countdown = useCountdown(waiting ? pairing?.expiresAt : undefined)

  const start = async () => {
    setBusy(true)
    await mapli.drive.startPairing()
    setBusy(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Le bandeau d'encre prend la hauteur de son contenu ; le gros plan violet, le reste. */}
      <div className="flex shrink-0 flex-col bg-ink px-5 pb-5 pt-6 text-white">
        <p className={`${kicker} text-white/60`}>
          {state.notice ? 'Poste déconnecté' : 'Première connexion'}
        </p>
        <h1 className="mt-2.5 text-[26px] font-medium leading-[1.08] tracking-[-0.035em]">
          Reliez ce poste à Mapli
        </h1>

        {state.notice && (
          <p className="mt-3 border-l-2 border-courrier bg-white/[0.06] px-3 py-2 text-[12px] leading-relaxed text-white/85">
            {state.notice}
          </p>
        )}

        {waiting && pairing ? (
          <>
            <p className="mt-3 text-[13px] leading-relaxed text-white/70">
              Sur app.mapli.fr, saisissez ce code puis approuvez ce poste. Il est copié quand vous
              ouvrez la page.
            </p>
            <div className="mt-5 rounded-[4px] bg-white py-4 text-center text-ink">
              <span className="select-text font-mono text-[30px] font-medium tracking-[0.08em]">
                {pairing.code}
              </span>
            </div>
            <button
              type="button"
              onClick={() => mapli.drive.openVerification()}
              className={`${whiteButton} mt-3`}
            >
              <ExternalLink className="h-4 w-4" />
              Ouvrir app.mapli.fr
            </button>
            <div className="mt-4 flex items-center justify-between gap-3 text-[12px] text-white/60">
              <span className="flex items-center gap-2">
                <span className="inline-flex gap-[3px]" aria-hidden="true">
                  <span className="cell h-[6px] w-[6px] bg-coffre" />
                  <span className="cell h-[6px] w-[6px] bg-coffre [animation-delay:0.2s]" />
                  <span className="cell h-[6px] w-[6px] bg-coffre [animation-delay:0.4s]" />
                </span>
                En attente de votre accord…
              </span>
              <span className="font-mono text-[11px] uppercase tracking-[0.06em]">{countdown}</span>
            </div>
            <button
              type="button"
              onClick={() => mapli.drive.cancelPairing()}
              className="mt-3 cursor-pointer self-start text-[12px] text-white/55 underline decoration-white/25 underline-offset-4 hover:text-white"
            >
              Annuler
            </button>
          </>
        ) : (
          <>
            <p className="mt-3 text-[13px] leading-relaxed text-white/70">
              {pairing?.status === 'expired'
                ? 'Ce code a expiré. Demandez-en un nouveau : il reste valable 15 minutes.'
                : pairing?.status === 'denied'
                  ? 'La demande a été refusée sur app.mapli.fr. Vous pouvez recommencer.'
                  : 'Mapli Drive monte le coffre-fort de votre organisation comme un lecteur de ce poste. Pour commencer, reliez-le à votre compte Mapli.'}
            </p>
            {state.error && (
              <p className="mt-3 border-l-2 border-danger bg-white/[0.06] px-3 py-2 text-[12px] text-white/85">
                {state.error}
              </p>
            )}
            <button
              type="button"
              onClick={start}
              disabled={busy || state.phase === 'pairing'}
              className={`${whiteButton} mt-5`}
            >
              {busy || (state.phase === 'pairing' && !pairing) ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : pairing ? (
                <RotateCcw className="h-4 w-4" />
              ) : null}
              {pairing ? 'Nouveau code' : 'Relier ce poste'}
            </button>
            <ol className="mt-6 space-y-0 text-[12px] text-white/70">
              {[
                'Un code s’affiche ici',
                'Vous l’approuvez sur app.mapli.fr',
                'Le lecteur Mapli apparaît sur ce poste'
              ].map((step, i) => (
                <li key={step} className="flex items-center gap-3 border-t border-white/10 py-2.5">
                  <span className="font-mono text-[11px] text-coffre">0{i + 1}</span>
                  {step}
                </li>
              ))}
            </ol>
          </>
        )}
      </div>

      <div className="relative min-h-[120px] flex-1 overflow-hidden bg-coffre">
        <CoffreCloseUp className="absolute inset-0 h-full w-full" />
      </div>
      <p className="flex shrink-0 items-center gap-2 border-t border-line bg-surface-dim px-4 py-2.5 text-[12px] text-muted">
        <Lock className="h-3.5 w-3.5" />
        Aucun mot de passe n’est gardé sur ce poste
      </p>
    </div>
  )
}
