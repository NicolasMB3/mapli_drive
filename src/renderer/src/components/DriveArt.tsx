import { useEffect, useId, useRef } from 'react'
import { cn } from '../lib/cn'
import './kit-drive.css'

/*
 * Deux dessins du kit de marque 1.2 (DS MAPLI/15-illustrations), animés : l'en-tête Mapli Drive
 * (en-tetes/en-tete-mapli-drive : le poste tape le code d'appairage, se relie à Mapli,
 * synchronise) et la vignette « Drive vide » (vignettes/vignette-drive-vide : trois fichiers
 * tombent dans le Drive, qui se verrouille). Tracés et textes repris tels quels (convertis en
 * JSX) ; seuls changent le vrai code d'appairage et l'identifiant du clipPath. Le CSS est celui
 * du kit (kit-drive.css). Chaque dessin joue jusqu'à une étape puis s'y arrête ; si le système
 * demande moins de mouvement, il n'y a pas d'animation et c'est l'image fixe du kit.
 */

/** Joue les animations du dessin jusqu'à `cible` (ms), puis les y arrête. */
function useJusqua(ref: React.RefObject<SVGSVGElement | null>, cible: number): void {
  useEffect(() => {
    const svg = ref.current
    if (!svg || typeof svg.getAnimations !== 'function') return
    const animations = svg.getAnimations({ subtree: true })
    if (animations.length === 0) return
    const arrete = (): void =>
      animations.forEach((a) => {
        a.pause()
        a.currentTime = cible
      })
    const maintenant = Number(animations[0].currentTime ?? 0)
    if (maintenant >= cible) {
      arrete()
      return
    }
    animations.forEach((a) => a.play())
    const timer = setTimeout(arrete, cible - maintenant)
    return () => clearTimeout(timer)
  }, [ref, cible])
}

/**
 * Étapes de l'en-tête Mapli Drive (boucle de 6 s) : `vide` — la carte du code est posée, le
 * curseur attend (1,18 s) ; `code` — le code est tapé, sans coche : l'accord est attendu sur
 * app.mapli.fr (2,08 s, juste avant la coche).
 */
const ETAPES = { vide: 1180, code: 2080 } as const

/** En-tête Mapli Drive (16:9, 480 × 270) à fond perdu ; `code` : le code d'appairage affiché. */
export function MapliDriveHeader({
  code,
  etape,
  className
}: {
  code?: string
  etape: keyof typeof ETAPES
  className?: string
}) {
  const ref = useRef<SVGSVGElement>(null)
  const uid = `mapli-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  useJusqua(ref, ETAPES[etape])
  return (
    <svg
      ref={ref}
      viewBox="0 0 480 270"
      preserveAspectRatio="xMidYMid slice"
      className={cn('mapli-en-tete mapli-anime', className)}
      aria-hidden="true"
    >
      <defs>
        <clipPath id={`${uid}-mapli-et-dr-clip`}>
          <rect x="8" y="24" width="124" height="26" />
        </clipPath>
      </defs>
      <g className="mapli-et-dr-all">
        <path
          className="mapli-et-dr-l1"
          d="M152,132H174"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="3.4"
          strokeLinecap="round"
          strokeDasharray="0.1 7"
        />
        <path
          className="mapli-et-dr-l2"
          d="M322,132H350"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="3.4"
          strokeLinecap="round"
          strokeDasharray="0.1 7"
        />
        <g className="mapli-et-dr-lp">
          <rect x="38" y="96" width="110" height="68" rx="7" fill="#121212" />
          <rect x="45" y="103" width="96" height="54" rx="3" fill="#FFFFFF" />
          <path d="M53,113h7l2,2.4h8v9.6h-17z" fill="#6A57EC" />
          <text x="75" y="122" fontSize="7.5" fontWeight="600" fill="#1C1C1A">
            Mapli Drive
          </text>
          <path
            d="M53,134H130M53,142H118M53,150H124"
            fill="none"
            stroke="#ECEBE4"
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path d="M26,164H160L152,173H34Z" fill="#121212" />
        </g>
        <g className="mapli-et-dr-cd">
          <g transform="translate(176 108) rotate(-4)">
            <rect width="142" height="56" rx="6" fill="#FFFFFF" />
            <text
              className="mapli-mono"
              x="12"
              y="17"
              fontSize="6.5"
              letterSpacing="0.1em"
              fill="#5E5E58"
            >
              CODE D’APPAIRAGE
            </text>
            <text
              className="mapli-mono"
              x="12"
              y="43"
              fontSize="18"
              fontWeight="500"
              letterSpacing="0.02em"
              fill="#121212"
            >
              {code}
            </text>
            <g clipPath={`url(#${uid}-mapli-et-dr-clip)`}>
              <g className="mapli-et-dr-ty" transform="translate(104 0)">
                <rect x="10" y="24" width="130" height="26" fill="#FFFFFF" />
                <rect
                  className="mapli-et-dr-cu"
                  x="11"
                  y="28"
                  width="2.4"
                  height="19"
                  fill="#6A57EC"
                  opacity="0"
                />
              </g>
            </g>
            <g className="mapli-et-dr-ok">
              <circle cx="132" cy="2" r="13" fill="#121212" />
              <g transform="translate(122.6 -7.4) scale(0.86)">
                <path
                  d="M9.87,17.14L15.33,4.86M9.87,17.14L5.1,12.3"
                  fill="none"
                  stroke="#DF7A45"
                  strokeWidth="3.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </g>
            </g>
          </g>
        </g>
        <g className="mapli-et-dr-tl">
          <g transform="translate(356 98) scale(0.7)">
            <rect width="100" height="100" rx="23" fill="#121212" />
            <path
              d="M20.27,69.85L29.53,49.05A9.54,9.54 0 0 1 46.97,56.81M41.16,69.85L50.42,49.05A9.54,9.54 0 0 1 67.86,56.81"
              fill="none"
              stroke="#FFFFFF"
              strokeWidth="13.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M62.06,69.85L79.73,30.15"
              fill="none"
              stroke="#DF7A45"
              strokeWidth="13.2"
              strokeLinecap="round"
            />
          </g>
        </g>
        <g className="mapli-et-dr-d1" opacity="0">
          <rect x="-9" y="-11" width="18" height="22" rx="2" fill="#FFFFFF" />
          <rect x="-9" y="-11" width="18" height="5" rx="2" fill="#121212" />
          <path
            d="M-5,0H5M-5,4.5H3"
            fill="none"
            stroke="#D8D8D1"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </g>
        <g className="mapli-et-dr-d2" opacity="0">
          <rect x="-9" y="-11" width="18" height="22" rx="2" fill="#FFFFFF" />
          <rect x="-9" y="-11" width="18" height="5" rx="2" fill="#DAD5FB" />
          <path
            d="M-5,0H5M-5,4.5H3"
            fill="none"
            stroke="#D8D8D1"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </g>
        <g className="mapli-et-dr-pl">
          <rect x="168" y="208" width="164" height="30" rx="15" fill="#FFFFFF" />
          <circle cx="186" cy="223" r="4.5" fill="#4AA066" />
          <text x="198" y="227" fontSize="10.5" fill="#1C1C1A">
            Synchronisé · à l’instant
          </text>
        </g>
      </g>
    </svg>
  )
}

/** Vignette « Drive vide » (4:3) : elle joue une fois, puis reste sur son image finale. */
export function DriveVideVignette({ className }: { className?: string }) {
  const ref = useRef<SVGSVGElement>(null)
  useJusqua(ref, 2400)
  return (
    <svg
      ref={ref}
      viewBox="0 0 120 90"
      className={cn('mapli-vignette mapli-anime', className)}
      aria-hidden="true"
    >
      <rect width="120" height="90" fill="#6A57EC" />
      <g className="mapli-vg-n4-f1">
        <g transform="rotate(-9 42 44)">
          <rect x="31" y="26" width="22" height="30" rx="2.5" fill="#DAD5FB" />
          <path
            d="M36,33H46"
            fill="none"
            stroke="#B9B0F6"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
        </g>
      </g>
      <g className="mapli-vg-n4-f2">
        <g transform="rotate(3 60 40)">
          <rect x="49" y="21" width="22" height="30" rx="2.5" fill="#FFFFFF" />
          <path
            d="M54,28H64"
            fill="none"
            stroke="#121212"
            strokeWidth="2.8"
            strokeLinecap="round"
          />
          <path
            d="M54,35H66M54,41H62"
            fill="none"
            stroke="#ECEBE4"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </g>
      </g>
      <g className="mapli-vg-n4-f3">
        <g transform="rotate(11 78 44)">
          <rect x="67" y="26" width="22" height="30" rx="2.5" fill="#EDEBFD" />
          <path
            d="M72,33H82"
            fill="none"
            stroke="#C9C2F9"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
        </g>
      </g>
      <g className="mapli-vg-n4-tr">
        <rect x="20" y="50" width="80" height="28" rx="7" fill="#121212" />
        <path d="M20,57H100" fill="none" stroke="#3A3A37" strokeWidth="2" />
      </g>
      <g className="mapli-vg-n4-lk">
        <path
          d="M56.2,64V61a3.8,3.8 0 0 1 7.6,0V64"
          fill="none"
          stroke="#FFFFFF"
          strokeWidth="2.4"
        />
        <rect x="53.5" y="63.5" width="13" height="10" rx="2" fill="#FFFFFF" />
        <path
          d="M59.3,71.4L60.7,68.2"
          fill="none"
          stroke="#DF7A45"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </g>
    </svg>
  )
}
