import { cn } from '../lib/cn'

/** Monogramme Mapli (le M en enveloppe), orange de la marque par défaut. */
export function MapliMark({
  className,
  color = '#DF7A45'
}: {
  className?: string
  color?: string
}) {
  return (
    <svg viewBox="0 0 32 20" className={cn('block', className)} aria-hidden="true">
      <path
        d="M5 20H0V6.08021C0 3.59343 2.85177 2.18635 4.82529 3.69939L14.2064 10.8916C14.7211 11.2861 15.3515 11.5 16 11.5C16.6485 11.5 17.2789 11.2861 17.7936 10.8916L27.1747 3.69939C29.1482 2.18635 32 3.59343 32 6.08021V20H27V10.5L17.7747 16.9577C17.2705 17.3107 16.6698 17.5 16.0543 17.5H15.9457C15.3302 17.5 14.7295 17.3107 14.2253 16.9577L5 10.5V20Z"
        fill={color}
      />
    </svg>
  )
}

const INK = '#121212'

/**
 * Gros plan du Coffre-fort (le même que sur app.mapli.fr) : un dossier classé, ses
 * pièces qui dépassent, le cadenas du chiffrement — posé de biais, à fond perdu.
 */
export function CoffreCloseUp({
  className,
  align = 'xMidYMid'
}: {
  className?: string
  align?: 'xMidYMid' | 'xMinYMid' | 'xMidYMin'
}) {
  const c = '#6B57F5'
  return (
    <svg
      viewBox="0 0 400 260"
      preserveAspectRatio={`${align} slice`}
      className={cn('block', className)}
      aria-hidden="true"
    >
      <g transform="rotate(-5 200 150)">
        <rect
          x="112"
          y="44"
          width="176"
          height="118"
          rx="4"
          fill="#fff"
          stroke={INK}
          strokeOpacity={0.14}
          transform="rotate(-7 200 103)"
        />
        <rect
          x="146"
          y="36"
          width="176"
          height="118"
          rx="4"
          fill="#fff"
          stroke={INK}
          strokeOpacity={0.14}
          transform="rotate(6 234 95)"
        />
        <path d="M60 104a6 6 0 0 1 6-6h86l16 18h262a6 6 0 0 1 6 6v210H60z" fill="#fff" />
        <text
          x="84"
          y="152"
          fontSize="15"
          fontWeight={600}
          fill={INK}
          fontFamily="Geist Variable, sans-serif"
        >
          Contrats
        </text>
        <text
          x="84"
          y="171"
          fontSize="12"
          fill={INK}
          opacity={0.5}
          fontFamily="Geist Variable, sans-serif"
        >
          12 documents · chiffrés
        </text>
        <rect x="84" y="196" width="160" height="5" rx="1" fill={INK} opacity={0.16} />
        <rect x="84" y="210" width="124" height="5" rx="1" fill={INK} opacity={0.16} />
        <rect x="84" y="224" width="140" height="5" rx="1" fill={INK} opacity={0.16} />
        <g transform="translate(316 182)">
          <path d="M-15 -10v-11a15 15 0 0 1 30 0v11" fill="none" stroke={c} strokeWidth={6} />
          <rect x="-28" y="-12" width="56" height="44" rx="6" fill={c} />
          <circle cy="6" r="5" fill="#fff" />
          <rect x="-2" y="8" width="4" height="12" rx="1" fill="#fff" />
        </g>
      </g>
    </svg>
  )
}
