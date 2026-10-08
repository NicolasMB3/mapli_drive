import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Mail, X } from 'lucide-react'
import type {
  DriveState,
  EmployeeSpaceGroup,
  EmployeeSpaceNewFolder,
  EmployeeSpaceSeats,
  SpaceResult
} from '@shared/types'
import { SalariesVignette } from './Art'
import { MapliButton, MapliCheck, Sign } from './Brand'
import { mapli } from '../lib/bridge'
import { cn } from '../lib/cn'
import { plural } from '../lib/format'
import { driveLabel } from '@shared/drive-label'

/*
 * Petite fenêtre de l'espace salariés (charte « Papier », vert des Salariés), en bas à
 * droite de l'écran :
 *  - après un dépôt dans M:\Espace salariés\<salarié>\<catégorie> : publier les documents
 *    dans son espace, en le prévenant (ou non) par e-mail — rien n'arrive chez lui sans
 *    cet accord ;
 *  - après la création d'un dossier dans M:\Espace salariés : créer l'espace salarié de la
 *    personne (sa fiche, son accès), dans la limite des places de l'offre.
 * Boutons de la marque au format bureau : le trait saute pendant l'envoi, puis la
 * confirmation montre le trait devenu coche.
 */

const kicker = 'font-mono text-[11px] uppercase tracking-[0.06em]'
const field =
  'h-8 w-full rounded-[3px] border border-input bg-surface px-2.5 text-[13px] text-ink outline-none transition-colors placeholder:text-muted focus:border-ink'
const quiet = 'cursor-pointer underline-offset-4 hover:text-ink hover:underline'
/** Vignette Salariés du kit, en haut à droite des propositions. */
const vignette = 'w-16 shrink-0 rounded-[4px]'

function firstName(name: string): string {
  return name.split(' ')[0] || name
}

export function EmployeeSpacePopup() {
  const [state, setState] = useState<DriveState | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void mapli.drive.state().then(setState)
    return mapli.drive.onState(setState)
  }, [])

  // La fenêtre prend la hauteur de son contenu.
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const report = () => mapli.space.resize(el.getBoundingClientRect().height)
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Après une action réussie : un mot de confirmation, puis la suite.
  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(null), 1800)
    return () => clearTimeout(timer)
  }, [flash])

  const prompt = state?.prompt ?? null
  const onDone = (result: SpaceResult) => {
    if (result.ok) setFlash(result.message)
  }

  return (
    <div ref={root} className="flex flex-col border border-line bg-surface">
      <div className="drag flex h-9 shrink-0 items-stretch border-b border-line">
        <span className="grid w-10 shrink-0 place-items-center border-r border-line">
          <Sign className="w-5" />
        </span>
        <span className={cn(kicker, 'flex min-w-0 flex-1 items-center px-3 text-muted')}>
          Mapli Drive · {driveLabel(state?.mountPoint ?? 'M:')}
        </span>
        <button
          type="button"
          onClick={() => void mapli.space.later()}
          className="no-drag grid w-10 cursor-pointer place-items-center bg-ink text-white transition-colors hover:bg-danger"
          title="Plus tard"
          aria-label="Plus tard"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {flash ? (
        <div className="flex items-center gap-3 px-4 py-4">
          <MapliCheck className="shrink-0" />
          <p className="text-[13px] leading-snug text-ink">{flash}</p>
        </div>
      ) : prompt?.kind === 'publish' ? (
        <PublishPrompt
          key={prompt.group.requests.map((r) => r.id).join()}
          group={prompt.group}
          onDone={onDone}
        />
      ) : prompt?.kind === 'folder' ? (
        <FolderPrompt
          key={prompt.folder.id}
          folder={prompt.folder}
          seats={prompt.seats}
          onDone={onDone}
        />
      ) : (
        <p className="px-4 py-4 text-[13px] text-muted">Rien à valider pour l’instant.</p>
      )}
    </div>
  )
}

// ── Publier dans son espace ──────────────────────────────

function PublishPrompt({
  group,
  onDone
}: {
  group: EmployeeSpaceGroup
  onDone: (r: SpaceResult) => void
}) {
  const [notify, setNotify] = useState(true)
  // Action en cours : le bouton principal ne montre l'attente que pour la publication.
  const [busy, setBusy] = useState<'publish' | 'discard' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const name = group.employee?.name ?? 'le salarié'
  const ids = group.requests.map((r) => r.id)
  const shown = group.requests.slice(0, 4)

  const run = async (kind: 'publish' | 'discard', action: () => Promise<SpaceResult>) => {
    setBusy(kind)
    setError(null)
    const result = await action()
    setBusy(null)
    if (result.ok) onDone(result)
    else setError(result.message)
  }

  return (
    <div className="px-4 pb-4 pt-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn(kicker, 'text-success-ink')}>Espace salariés</p>
          <p className="mt-1 text-[15px] font-semibold leading-snug tracking-[-0.01em] text-ink">
            {plural(group.requests.length, 'document')} pour {name}
          </p>
        </div>
        <SalariesVignette className={vignette} />
      </div>
      <ul className="mt-2.5 space-y-0.5 border-l-2 border-success pl-2.5 text-[13px] text-body">
        {shown.map((r) => (
          <li key={r.id} className="truncate">
            {r.name}
          </li>
        ))}
        {group.requests.length > shown.length && (
          <li className="text-muted">et {plural(group.requests.length - shown.length, 'autre')}</li>
        )}
      </ul>
      {group.category && (
        <p className={cn(kicker, 'mt-1.5 pl-3 text-[10.5px] text-muted')}>
          → catégorie {group.category.name}
        </p>
      )}

      <label className="mt-3 flex cursor-pointer items-center gap-2 text-[13px] text-ink">
        <input
          type="checkbox"
          checked={notify}
          onChange={(e) => setNotify(e.target.checked)}
          className="h-4 w-4 accent-[#12a15f]"
        />
        <Mail className="h-3.5 w-3.5 text-muted" /> Prévenir {firstName(name)} par e-mail
      </label>

      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}

      <div className="mt-3 flex gap-2">
        <MapliButton
          size="petit"
          loading={busy === 'publish'}
          disabled={busy === 'discard'}
          onClick={() => void run('publish', () => mapli.space.publish(ids, notify))}
          className="flex-1"
        >
          {busy === 'publish' ? 'Publication…' : 'Publier dans son espace'}
        </MapliButton>
        <MapliButton
          size="petit"
          variant="secondaire"
          disabled={busy !== null}
          onClick={() => void mapli.space.later()}
        >
          Plus tard
        </MapliButton>
      </div>
      <p className="mt-2.5 text-[11.5px] leading-snug text-muted">
        Rien n’arrive chez {firstName(name)} sans votre accord ·{' '}
        <button
          type="button"
          className={quiet}
          onClick={() => void mapli.space.openWeb(group.web_url)}
        >
          Voir sur Mapli
        </button>{' '}
        ·{' '}
        <button
          type="button"
          disabled={busy !== null}
          className={quiet}
          onClick={() => void run('discard', () => mapli.space.discard(ids))}
        >
          Ne pas publier
        </button>
      </p>
    </div>
  )
}

// ── Créer son espace salarié ─────────────────────────────

function seatsLabel(seats: EmployeeSpaceSeats): string {
  if (seats.limit === -1) return 'Places illimitées avec votre offre.'
  if (!seats.can_create)
    return `Toutes les places de votre offre sont prises (${seats.used} sur ${seats.limit}).`
  return `${plural(seats.remaining ?? 0, 'place restante', 'places restantes')} sur ${seats.limit}.`
}

function FolderPrompt({
  folder,
  seats,
  onDone
}: {
  folder: EmployeeSpaceNewFolder
  seats: EmployeeSpaceSeats | null
  onDone: (r: SpaceResult) => void
}) {
  const [first, setFirst] = useState(folder.suggested.first_name)
  const [last, setLast] = useState(folder.suggested.last_name)
  // Dossier renommé pendant que la fenêtre est ouverte : prénom et nom suivent le nouveau nom,
  // tant que la personne ne les a pas changés elle-même.
  const [suggestedFor, setSuggestedFor] = useState(folder.suggested)
  if (
    suggestedFor.first_name !== folder.suggested.first_name ||
    suggestedFor.last_name !== folder.suggested.last_name
  ) {
    setSuggestedFor(folder.suggested)
    if (first === suggestedFor.first_name) setFirst(folder.suggested.first_name)
    if (last === suggestedFor.last_name) setLast(folder.suggested.last_name)
  }
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [line1, setLine1] = useState('')
  const [postal, setPostal] = useState('')
  const [city, setCity] = useState('')
  // Action en cours : le bouton principal ne montre l'attente que pour la création.
  const [busy, setBusy] = useState<'create' | 'keep' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const full = seats ? !seats.can_create : false

  const run = async (kind: 'create' | 'keep', action: () => Promise<SpaceResult>) => {
    setBusy(kind)
    setError(null)
    const result = await action()
    setBusy(null)
    if (result.ok) onDone(result)
    else setError(result.message)
  }

  const submit = () => {
    if (!first.trim() || !last.trim()) return setError('Indiquez son prénom et son nom.')
    if (!/^\S+@\S+\.\S+$/.test(email.trim()))
      return setError('Indiquez son e-mail : il y recevra son lien d’activation.')
    const anyAddress = line1.trim() || postal.trim() || city.trim()
    if (anyAddress && (!line1.trim() || !/^\d{5}$/.test(postal.trim()) || !city.trim())) {
      return setError('Adresse : rue, code postal à 5 chiffres et ville.')
    }
    void run('create', () =>
      mapli.space.createEmployee(folder.id, {
        first_name: first.trim(),
        last_name: last.trim(),
        email: email.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(anyAddress
          ? { address: { line1: line1.trim(), postal_code: postal.trim(), city: city.trim() } }
          : {})
      })
    )
  }

  return (
    <div className="px-4 pb-4 pt-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn(kicker, 'text-success-ink')}>Espace salariés</p>
          <p className="mt-1 text-[15px] font-semibold leading-snug tracking-[-0.01em] text-ink">
            Nouveau dossier « {folder.name} »
          </p>
        </div>
        <SalariesVignette className={vignette} />
      </div>
      <p className="mt-1 text-[12.5px] leading-snug text-body">
        Créer son espace salarié ? Il recevra un e-mail pour l’activer, et ce dossier deviendra le
        sien.
      </p>

      {full ? (
        <p className="mt-3 rounded-[3px] bg-[#fff3d6] px-2.5 py-2 text-[12.5px] text-[#7a5a00]">
          {seats && seatsLabel(seats)}{' '}
          <button
            type="button"
            className="font-medium underline underline-offset-4"
            onClick={() => void mapli.drive.openWeb('vault')}
          >
            Voir sur Mapli
          </button>
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <input
              aria-label="Prénom"
              placeholder="Prénom"
              value={first}
              onChange={(e) => setFirst(e.target.value)}
              className={field}
            />
            <input
              aria-label="Nom"
              placeholder="Nom"
              value={last}
              onChange={(e) => setLast(e.target.value)}
              className={field}
            />
          </div>
          <input
            aria-label="E-mail"
            type="email"
            placeholder="E-mail"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={field}
            autoFocus
          />
          <input
            aria-label="Téléphone (facultatif)"
            type="tel"
            placeholder="Téléphone (facultatif)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={field}
          />
          <p className={cn(kicker, 'pt-1 text-[10.5px] text-muted')}>
            Adresse postale · facultatif
          </p>
          <input
            aria-label="Rue"
            placeholder="Rue"
            maxLength={45}
            value={line1}
            onChange={(e) => setLine1(e.target.value)}
            className={field}
          />
          <div className="grid grid-cols-[104px_minmax(0,1fr)] gap-2">
            <input
              aria-label="Code postal"
              placeholder="Code postal"
              inputMode="numeric"
              maxLength={5}
              value={postal}
              onChange={(e) => setPostal(e.target.value)}
              className={field}
            />
            <input
              aria-label="Ville"
              placeholder="Ville"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className={field}
            />
          </div>
          {seats && <p className="text-[11.5px] text-muted">{seatsLabel(seats)}</p>}
        </div>
      )}

      {error && <p className="mt-2 text-[12px] text-danger">{error}</p>}

      <div className="mt-3 flex gap-2">
        {!full && (
          <MapliButton
            size="petit"
            loading={busy === 'create'}
            disabled={busy === 'keep'}
            onClick={submit}
            className="flex-1"
          >
            {busy === 'create' ? 'Création…' : 'Créer son espace'}
          </MapliButton>
        )}
        <MapliButton
          size="petit"
          variant="secondaire"
          disabled={busy !== null}
          onClick={() => void mapli.space.later()}
          className={cn(full && 'flex-1')}
        >
          Plus tard
        </MapliButton>
      </div>
      <p className="mt-2.5 text-[11.5px] leading-snug text-muted">
        <button
          type="button"
          disabled={busy !== null}
          className={quiet}
          onClick={() => void run('keep', () => mapli.space.keepFolder(folder.id))}
        >
          Garder un simple dossier
        </button>{' '}
        ·{' '}
        <button
          type="button"
          className={quiet}
          onClick={() => void mapli.space.openWeb(folder.web_url)}
        >
          Voir sur Mapli
        </button>
      </p>
    </div>
  )
}
