import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '../lib/cn'
import './brand.css'

/*
 * La marque Mapli (kit de marque, DS MAPLI/design, version 1.1) : le signe « m/ » — le m et
 * son trait orange, plus haut que lui —, l'indicateur de chargement et le bouton noir au
 * trait orange. Les tracés sont ceux des fichiers du kit, recopiés sans retouche ; la même
 * approche que les composants de mapli.fr (mapli_home, components/logo.tsx).
 */

/** Le m du signe et son trait (01-logo/svg/mapli-signe-*.svg), dans le repère de la tuile 0 0 100 100. */
const SIGN_M_PATH =
  'M14.54,67.3L23.8,46.5A6.27,6.27 0 0 1 35.26,51.6L25.99,72.4A6.27,6.27 0 0 1 14.54,67.3ZM23.8,46.5A15.81,15.81 0 0 1 52.69,59.36A6.27,6.27 0 0 1 41.24,54.26A3.28,3.28 0 0 0 35.26,51.6A6.27,6.27 0 0 1 23.8,46.5ZM35.44,67.3L44.7,46.5A6.27,6.27 0 0 1 56.15,51.6L46.89,72.4A6.27,6.27 0 0 1 35.44,67.3ZM44.7,46.5A15.81,15.81 0 0 1 66.33,38.84L61.2,50.38A3.28,3.28 0 0 0 56.15,51.6A6.27,6.27 0 0 1 44.7,46.5Z'
const SIGN_STROKE_PATH =
  'M56.33,67.3L74.01,27.6A6.27,6.27 0 0 1 85.46,32.7L67.78,72.4A6.27,6.27 0 0 1 56.33,67.3Z'

/** Couleurs du kit : encre du logo, orange du trait, noir de l'icône. */
const BRAND = { ink: '#1C1C1A', orange: '#DF7A45', black: '#121212' } as const

/**
 * Le signe « m/ » : fond clair = m encre et trait orange ; fond sombre = m blanc et trait
 * orange. 20 px de large au moins (kit, 01-logo) : en dessous, l'icône en petites tailles.
 */
export function Sign({
  tone = 'clair',
  className,
  title
}: {
  tone?: 'clair' | 'sombre'
  className?: string
  title?: string
}) {
  return (
    <svg
      viewBox="12 22 76 56"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      className={cn('block h-auto shrink-0', className)}
    >
      <path fill={tone === 'clair' ? BRAND.ink : '#FFFFFF'} d={SIGN_M_PATH} />
      <path fill={BRAND.orange} d={SIGN_STROKE_PATH} />
    </svg>
  )
}

/**
 * Indicateur de chargement (kit, 04-animations/chargement) : le trait décolle du m, fait un
 * tour, retombe, et change de couleur à chaque saut. `sombre` sur l'encre, sinon `background`
 * = la couleur du fond (détourage du trait). Taille conseillée : 48 à 120 px de large.
 * `delayed` : n'apparaît que si l'attente dure (écran de démarrage).
 */
export function MapliLoader({
  tone = 'clair',
  background = '#FFFFFF',
  size = 72,
  label = 'Chargement',
  delayed,
  className
}: {
  tone?: 'clair' | 'sombre'
  background?: string
  size?: number
  label?: string
  delayed?: boolean
  className?: string
}) {
  return (
    <svg
      className={cn(
        'mapli-loader',
        tone === 'sombre' && 'mapli-loader--sombre',
        delayed && 'mapli-loader--retarde',
        className
      )}
      viewBox="0 -12 100 92"
      role="img"
      aria-label={label}
      style={{
        width: size,
        ...(tone === 'clair' ? { ['--mapli-loader-fond' as string]: background } : {})
      }}
    >
      <path
        className="mapli-loader-m"
        d="M20.27,69.85L29.53,49.05A9.54,9.54 0 0 1 46.97,56.81M41.16,69.85L50.42,49.05A9.54,9.54 0 0 1 67.86,56.81L62.06,69.85"
      />
      <g transform="translate(70.89 50)">
        <g className="mapli-loader-jump">
          <g className="mapli-loader-spin">
            <path className="mapli-loader-ko" d="M-8.84,19.85L8.84,-19.85" />
            <path className="mapli-loader-col" d="M-8.84,19.85L8.84,-19.85" />
          </g>
        </g>
      </g>
    </svg>
  )
}

/**
 * Le trait des boutons (kit, 16-boutons) : toujours la même icône, seul l'état change —
 * penché au repos, flèche au survol, saut en chargement, coche au succès.
 */
function Trait() {
  return (
    <svg className="mapli-btn__icone" viewBox="0 0 22 22" aria-hidden="true">
      <g className="mapli-btn__saut">
        <g className="mapli-btn__tour">
          <path className="mapli-btn__trait" d="M3,11H19" />
          <path className="mapli-btn__pointe" pathLength={1} d="M13.4,5.4L19,11L13.4,16.6" />
          <path className="mapli-btn__coche" pathLength={1} d="M8.27,17.14L3.5,12.3" />
        </g>
      </g>
    </svg>
  )
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  children: ReactNode
  /** `secondaire` : contour, le noir entre en biais au survol. */
  variant?: 'principal' | 'secondaire'
  /** Sur fond noir : le bouton passe au papier. */
  clair?: boolean
  /** 36 px (bureau), 48 px (par défaut). */
  size?: 'petit' | 'normal'
  /** Toute la largeur, le trait part à droite. */
  wide?: boolean
  /** Attente : le trait saute ; les clics sont ignorés (le bouton reste noir, pas grisé). */
  loading?: boolean
  /** Succès : le trait devient coche. */
  success?: boolean
}

/**
 * Le bouton de la marque (kit, 16-boutons) : noir, texte blanc, et le trait orange qui
 * devient flèche au survol, saute pendant l'attente (`loading`, avec aria-busy) et devient
 * coche au succès (`success`). Jamais de fond orange.
 */
export function MapliButton({
  variant = 'principal',
  clair,
  size = 'normal',
  wide,
  loading,
  success,
  className,
  children,
  onClick,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      {...rest}
      aria-busy={loading || undefined}
      onClick={loading ? undefined : onClick}
      className={cn(
        'mapli-btn',
        variant === 'secondaire' && 'mapli-btn--secondaire',
        clair && 'mapli-btn--clair',
        size === 'petit' && 'mapli-btn--petit',
        wide && 'mapli-btn--large',
        loading && 'est-en-charge',
        !loading && success && 'est-reussi',
        className
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      <Trait />
    </button>
  )
}

/**
 * Lien de la marque (kit, `mapli-lien`) : le soulignement se trace au survol, le trait
 * devient la flèche. Ici en bouton (l'action passe par le processus principal), compact.
 */
export function MapliLink({
  children,
  className,
  type = 'button',
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { children: ReactNode }) {
  return (
    <button type={type} {...rest} className={cn('mapli-lien mapli-lien--petit', className)}>
      <span className="mapli-lien__texte">{children}</span>
      <Trait />
    </button>
  )
}

/**
 * Confirmation : le trait du bouton qui devient coche (état « succès » du kit), sur un carré
 * noir, joué à l'apparition. Purement visuel : le message dit ce qui a réussi.
 */
export function MapliCheck({ className }: { className?: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    // Une image plus tard : la petite branche de la coche se trace au lieu d'apparaître.
    const frame = requestAnimationFrame(() => setDone(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <span
      aria-hidden="true"
      className={cn(
        'mapli-btn mapli-btn--petit mapli-btn--icone pointer-events-none',
        done && 'est-reussi',
        className
      )}
    >
      <Trait />
    </span>
  )
}
