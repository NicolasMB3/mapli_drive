import { cn } from '../lib/cn'

/*
 * Illustrations du kit de marque (DS MAPLI/design, 15-illustrations), en version fixe : du
 * papier blanc penché, un objet noir, le fond à la couleur du produit (Coffre-fort violet,
 * Salariés vert). Dessins recopiés sans retouche ; seule la police est celle de l'application.
 */

const FONT = "'Geist Variable', Geist, Inter, system-ui, sans-serif"
const COFFRE = '#6A57EC'
const SALARIES = '#4AA066'
const BLACK = '#121212'

/**
 * Coffre-fort (15-illustrations/produits/illustration-coffre-fort) : des documents rangés
 * dans un dossier fermé par un cadenas. 16:9, posée à fond perdu (`slice`) ; `xMidYMax`
 * garde le bas entier (le nom du dossier et ses fichiers) quand la place manque.
 */
export function CoffreIllustration({
  className,
  align = 'xMidYMid'
}: {
  className?: string
  align?: 'xMidYMid' | 'xMidYMax'
}) {
  return (
    <svg
      viewBox="0 0 480 270"
      preserveAspectRatio={`${align} slice`}
      className={cn('block', className)}
      fontFamily={FONT}
      aria-hidden="true"
    >
      <rect width="480" height="270" fill={COFFRE} />
      <g transform="translate(84 54) rotate(-9)">
        <rect width="110" height="170" rx="5" fill="#DAD5FB" />
        <rect x="14" y="16" width="52" height="7" rx="3.5" fill="#B9B0F6" />
        <rect x="14" y="31" width="76" height="6" rx="3" fill="#C9C2F9" />
      </g>
      <g transform="translate(170 66) rotate(-12)">
        <rect width="120" height="170" rx="5" fill="#EDEBFD" />
        <rect x="14" y="16" width="60" height="7" rx="3.5" fill="#C9C2F9" />
        <rect x="14" y="31" width="86" height="6" rx="3" fill="#DAD5FB" />
      </g>
      <g transform="translate(232 38) rotate(-3)">
        <rect width="130" height="180" rx="5" fill="#FFFFFF" />
        <rect x="16" y="18" width="62" height="8" rx="4" fill={BLACK} />
        <rect x="16" y="36" width="96" height="6" rx="3" fill="#ECEBE4" />
        <rect x="16" y="48" width="84" height="6" rx="3" fill="#ECEBE4" />
      </g>
      <g transform="translate(52 104) rotate(-6)" fill="#1C1C1A">
        <path
          d="M6,0H112a6,6 0 0 1 5.4,3.4L124.6,18.6a6,6 0 0 0 5.4,3.4H324a6,6 0 0 1 6,6V250H0V6a6,6 0 0 1 6,-6Z"
          fill="#FFFFFF"
        />
        <text x="28" y="64" fontSize="22" fontWeight={600}>
          Contrats
        </text>
        <text x="28" y="86" fontSize="13.5" fill="#5E5E58">
          12 documents · chiffrés
        </text>
        <rect x="28" y="106" width="8" height="8" fill={COFFRE} />
        <text x="46" y="115" fontSize="13">
          Bail commercial.pdf
        </text>
        <rect x="28" y="128" width="8" height="8" fill={COFFRE} />
        <text x="46" y="137" fontSize="13">
          Statuts à jour.pdf
        </text>
        <rect x="28" y="150" width="8" height="8" fill={COFFRE} />
        <text x="46" y="159" fontSize="13">
          Attestation URSSAF.pdf
        </text>
      </g>
      <path
        d="M394,156V122a24,24 0 0 1 48,0V182"
        fill="none"
        stroke={BLACK}
        strokeWidth={16}
        strokeLinecap="round"
      />
      <rect x="372" y="150" width="92" height="78" rx="12" fill={BLACK} />
      <path
        transform="translate(418 189)"
        d="M-5.3,11.9L5.3,-11.9"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={10}
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * Vignette Coffre-fort (15-illustrations/vignettes/vignette-coffre-fort) : un document
 * protégé par un cadenas. 4:3, prévue pour 112 × 84 px.
 */
export function CoffreVignette({
  className,
  slice
}: {
  className?: string
  /** À fond perdu dans une case d'une autre proportion. */
  slice?: boolean
}) {
  return (
    <svg
      viewBox="0 0 120 90"
      preserveAspectRatio={slice ? 'xMidYMid slice' : undefined}
      className={cn('block', className)}
      aria-hidden="true"
    >
      <rect width="120" height="90" fill={COFFRE} />
      <g transform="rotate(-8 44 45)">
        <rect x="18" y="13" width="50" height="68" rx="4" fill="#FFFFFF" />
        <path d="M27,26H45" fill="none" stroke={BLACK} strokeWidth={4.8} strokeLinecap="round" />
        <path
          d="M27,37H58M27,46H54"
          fill="none"
          stroke="#D8D8D1"
          strokeWidth={3.6}
          strokeLinecap="round"
        />
      </g>
      <path
        d="M61,52V38a13,13 0 0 1 26,0V62"
        fill="none"
        stroke={BLACK}
        strokeWidth={8}
        strokeLinecap="round"
      />
      <rect x="50" y="48" width="48" height="36" rx="7" fill={BLACK} />
      <path
        transform="translate(74 66)"
        d="M-2.9,6.5L2.9,-6.5"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth={5.6}
        strokeLinecap="round"
      />
    </svg>
  )
}

/**
 * Vignette Salariés (15-illustrations/vignettes/vignette-salaries) : un badge suspendu.
 * 4:3, prévue pour 112 × 84 px.
 */
export function SalariesVignette({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 90" className={cn('block', className)} aria-hidden="true">
      <rect width="120" height="90" fill={SALARIES} />
      <g transform="rotate(-4 60 -30)">
        <path
          d="M44.4,-6L57.5,23.5M75.6,-6L62.5,23.5"
          fill="none"
          stroke={BLACK}
          strokeWidth={6.5}
        />
        <rect x="33" y="28" width="54" height="72" rx="7" fill="#FFFFFF" />
        <rect x="52" y="34.5" width="16" height="4.6" rx="2.3" fill={SALARIES} />
        <rect x="55" y="20" width="10" height="17" rx="3" fill={BLACK} />
        <circle cx="60" cy="57" r="10.5" fill={BLACK} />
        <path d="M47,78H73" fill="none" stroke={BLACK} strokeWidth={4.8} strokeLinecap="round" />
      </g>
    </svg>
  )
}
