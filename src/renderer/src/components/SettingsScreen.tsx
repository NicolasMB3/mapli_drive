import { useEffect, useState, type ReactNode } from 'react'
import { ArrowLeft, Loader2, LogOut } from 'lucide-react'
import type { AppInfo, DriveSettings, DriveState, UpdateStatus } from '@shared/types'
import { mapli } from '../lib/bridge'
import { cn } from '../lib/cn'

/*
 * Réglages : le lecteur (lettre, cache), le démarrage, ce poste (organisation, compte,
 * déconnexion), les mises à jour. En-tête clair, sections à filets.
 */

const kicker = 'font-mono text-[11px] uppercase tracking-[0.06em]'
const selectCls = 'h-8 cursor-pointer rounded-[4px] border border-input bg-surface px-2 text-[12px] text-ink focus:border-ink focus:outline-none'

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line px-4 py-4 first:border-t-0">
      <p className={`${kicker} mb-2.5 text-ink`}>{title}</p>
      {children}
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="min-w-0">
        <span className="block text-[13px] text-ink">{label}</span>
        {hint && <span className="block text-[11px] leading-snug text-muted">{hint}</span>}
      </span>
      <span className="shrink-0">{children}</span>
    </div>
  )
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn('relative h-5 w-9 cursor-pointer rounded-[4px] transition-colors', checked ? 'bg-ink' : 'bg-input')}
    >
      <span className={cn('absolute top-[3px] h-[14px] w-[14px] rounded-[2px] bg-white transition-all', checked ? 'left-[19px]' : 'left-[3px]')} />
    </button>
  )
}

const UPDATE_LABEL: Record<UpdateStatus, string> = {
  idle: 'Vérifier les mises à jour',
  checking: 'Vérification…',
  'up-to-date': 'Vous êtes à jour',
  available: 'Mise à jour disponible — Télécharger',
  downloading: 'Téléchargement de la mise à jour…',
  ready: 'Installer et redémarrer',
  error: 'Erreur — Réessayer',
}

export function SettingsScreen({ state, info, onBack }: { state: DriveState; info: AppInfo | null; onBack: () => void }) {
  const isMac = info?.platform === 'darwin'
  const [settings, setSettings] = useState<DriveSettings | null>(null)
  const [letters, setLetters] = useState<string[]>([])
  const [update, setUpdate] = useState<{ status: UpdateStatus; version?: string }>({ status: 'idle' })
  const [confirmUnpair, setConfirmUnpair] = useState(false)
  const [unpairing, setUnpairing] = useState(false)

  useEffect(() => {
    void mapli.settings.get().then(setSettings)
    void mapli.settings.mountPoints().then(setLetters)
    void mapli.updater.status().then(setUpdate)
    return mapli.updater.onStatus(setUpdate)
  }, [])

  const change = async (next: Partial<DriveSettings>) => {
    setSettings((s) => (s ? { ...s, ...next } : s))
    setSettings(await mapli.settings.set(next))
  }

  const unpair = async () => {
    if (!confirmUnpair) {
      setConfirmUnpair(true)
      setTimeout(() => setConfirmUnpair(false), 4000)
      return
    }
    setUnpairing(true)
    await mapli.drive.unpair()
    setUnpairing(false)
    onBack()
  }

  const updateAction = () => {
    if (update.status === 'ready' || (update.status === 'available' && isMac)) void mapli.updater.install()
    else void mapli.updater.check()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-end gap-3 border-b border-line px-4 pb-4 pt-5">
        <button type="button" onClick={onBack} className="-ml-1 grid h-8 w-8 cursor-pointer place-items-center rounded-[4px] text-ink hover:bg-ink/[0.06]" aria-label="Retour">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div>
          <p className={`${kicker} text-coffre`}>Mapli Drive</p>
          <h1 className="mt-1 text-[24px] font-medium leading-none tracking-[-0.035em]">Réglages</h1>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
        <Section title="Lecteur">
          {isMac ? (
            <Row label="Volume « Mapli »" hint="Dans le Finder, sous « Emplacements ».">
              <span className="text-[12px] text-muted">{state.mountPoint}</span>
            </Row>
          ) : (
            <>
              <Row label="Lettre du lecteur" hint="Le lecteur est remonté sous la nouvelle lettre.">
                <select className={selectCls} value={settings?.mountPoint ?? ''} onChange={(e) => change({ mountPoint: e.target.value })}>
                  {letters.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Cache local" hint="Fichiers ouverts récemment, gardés sur ce poste.">
                <select className={selectCls} value={settings?.cacheSizeGb ?? 10} onChange={(e) => change({ cacheSizeGb: Number(e.target.value) })}>
                  {[5, 10, 20, 50].map((size) => (
                    <option key={size} value={size}>
                      {size} Go
                    </option>
                  ))}
                </select>
              </Row>
            </>
          )}
        </Section>

        <Section title="Démarrage">
          <Row label="Lancer Mapli Drive à l’ouverture de session" hint="Le lecteur est prêt dès que vous allumez le poste.">
            <Toggle checked={settings?.autoStart ?? true} onChange={(v) => change({ autoStart: v })} label="Lancer au démarrage" />
          </Row>
        </Section>

        {state.device && (
          <Section title="Ce poste">
            <div className="text-[13px]">
              <p className="font-medium text-ink">{state.device.organization.name}</p>
              <p className="text-[12px] text-muted">
                {state.device.user.first_name} {state.device.user.last_name} · {state.device.user.email}
              </p>
            </div>
            <button
              type="button"
              onClick={unpair}
              disabled={unpairing}
              className="mt-3 flex h-8 cursor-pointer items-center gap-2 rounded-[4px] border border-danger/30 bg-surface px-3 text-[12px] font-medium text-danger transition-colors hover:bg-danger/5 disabled:opacity-60"
            >
              {unpairing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogOut className="h-3.5 w-3.5" />}
              {confirmUnpair ? 'Confirmer : déconnecter ce poste' : 'Déconnecter ce poste'}
            </button>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              Le lecteur disparaît de ce poste ; vos documents restent dans le coffre-fort. Vous pouvez aussi déconnecter ce poste depuis
              app.mapli.fr (Réglages → Sécurité → Appareils connectés).
            </p>
          </Section>
        )}

        <Section title="Mises à jour">
          <button
            type="button"
            onClick={updateAction}
            disabled={update.status === 'checking' || update.status === 'downloading'}
            className={cn(
              'flex h-8 cursor-pointer items-center gap-2 rounded-[4px] px-3 text-[12px] font-medium transition-opacity disabled:cursor-wait disabled:opacity-70',
              update.status === 'ready' ? 'bg-ink text-white hover:opacity-90' : 'border border-input bg-surface text-ink hover:bg-surface-dim',
            )}
          >
            {(update.status === 'checking' || update.status === 'downloading') && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {UPDATE_LABEL[update.status]}
            {update.version && (update.status === 'ready' || update.status === 'available') ? ` (v${update.version})` : ''}
          </button>
        </Section>

        <Section title="À propos">
          <p className="text-[12px] leading-relaxed text-muted">
            <span className="font-medium text-ink">Mapli Drive</span> v{info?.version} — le coffre-fort Mapli dans votre {isMac ? 'Finder' : 'Explorateur'}.
            Les fichiers sont chiffrés sur les serveurs de Mapli, et ce poste n’accède qu’à ce que votre compte peut voir.
          </p>
        </Section>
      </div>
    </div>
  )
}
