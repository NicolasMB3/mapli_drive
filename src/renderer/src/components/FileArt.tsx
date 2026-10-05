import { cn } from '../lib/cn'
import { fileKind, fileLabel, type FileKind } from '../lib/file-kind'

/*
 * Feuilles des fichiers (charte « Papier ») : une page vue de face, coin corné, dont le
 * dessin dit le type — lignes d'un texte, signature d'un PDF, grille d'un tableur,
 * paysage d'une photo… — et l'étiquette violette du Coffre-fort qui porte l'extension.
 * La même idée que les feuilles du coffre-fort web, à la taille d'une ligne.
 */

const INK = '#121212'
const COFFRE = '#6B57F5'
const COFFRE_INK = '#4B3BC4'
const TINT = '#EEEBFF'
const FOLD = '#EDECE6'
const BRAND = '#DF7A45'

/** Une ligne de texte simulée. */
function Line({ y, width, x = 7 }: { y: number; width: number; x?: number }) {
  return <rect x={x} y={y} width={width} height={1.6} fill={INK} opacity={0.16} />
}

/** Le dessin de la page, dans la zone x 7→25, y 7→27 (l'étiquette occupe le bas). */
function Drawing({ kind }: { kind: FileKind }) {
  switch (kind) {
    case 'pdf':
      // Un devis, un contrat : titre, paragraphe, signature.
      return (
        <>
          <rect x={7} y={7} width={9} height={2.4} fill={COFFRE} />
          <Line y={11.6} width={18} />
          <Line y={14.6} width={18} />
          <Line y={17.6} width={12} />
          <path
            d="M14 24.6c1.1-2.4 2-3.2 2.4-2.3.5 1.1-1.3 2.8-.4 2.9.9.1 1.8-2.2 2.7-2 .8.2.3 1.7 1.1 1.7.6 0 1.1-.6 1.8-1.1"
            fill="none"
            stroke={COFFRE}
            strokeWidth={1.1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <rect x={13.4} y={26.2} width={11.6} height={0.8} fill={INK} opacity={0.25} />
        </>
      )
    case 'text':
      return (
        <>
          <rect x={7} y={7} width={9} height={2.4} fill={COFFRE} />
          <Line y={11.6} width={18} />
          <Line y={14.6} width={18} />
          <Line y={17.6} width={13} />
          <Line y={21.6} width={18} />
          <Line y={24.6} width={15} />
        </>
      )
    case 'sheet':
      // Grille d'un tableur : en-tête violet clair, une case remplie.
      return (
        <>
          <rect x={7} y={7} width={18} height={4} fill={TINT} />
          <rect x={19} y={14.75} width={6} height={3.75} fill={COFFRE} />
          <g fill="none" stroke={INK} strokeOpacity={0.24} strokeWidth={0.8}>
            <rect x={7} y={7} width={18} height={19} />
            <path d="M13 7v19M19 7v19M7 11h18M7 14.75h18M7 18.5h18M7 22.25h18" />
          </g>
        </>
      )
    case 'slides':
      // Une diapositive : histogramme qui monte.
      return (
        <>
          <Line y={7} width={10} />
          <rect x={7} y={10.4} width={18} height={12.6} fill={TINT} />
          <rect x={10} y={17} width={2.6} height={4} fill={COFFRE} />
          <rect x={14.7} y={14.5} width={2.6} height={6.5} fill={COFFRE} />
          <rect x={19.4} y={12.4} width={2.6} height={8.6} fill={COFFRE} />
          <Line y={25.2} width={13} />
        </>
      )
    case 'image':
      // Une photo : soleil orange de Mapli, collines violettes.
      return (
        <>
          <rect x={7} y={7} width={18} height={18} fill={TINT} />
          <circle cx={20.6} cy={11.6} r={2.2} fill={BRAND} />
          <path d="M11.5 25l7-9 6.5 7.6V25z" fill={COFFRE} opacity={0.45} />
          <path d="M7 25l5-6.6 4.2 5 2.6-2.6L22 25z" fill={COFFRE} />
        </>
      )
    case 'video':
      return (
        <>
          <rect x={7} y={8} width={18} height={14} fill={INK} />
          <path d="M14.2 11.8v6.4l5.4-3.2z" fill="#fff" />
          <rect x={7} y={24.6} width={18} height={1.6} fill={INK} opacity={0.12} />
          <rect x={7} y={24.6} width={7} height={1.6} fill={COFFRE} />
        </>
      )
    case 'audio':
      return (
        <>
          {[3, 7, 11, 6, 13, 9, 4, 8].map((h, i) => (
            <rect
              key={i}
              x={7.5 + i * 2.25}
              y={16.5 - h / 2}
              width={1.3}
              height={h}
              rx={0.65}
              fill={COFFRE}
            />
          ))}
        </>
      )
    case 'archive':
      // Une archive : la fermeture éclair, sa tirette violette.
      return (
        <>
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <rect
              key={i}
              x={i % 2 ? 16 : 13.6}
              y={3 + i * 2.4}
              width={2.4}
              height={1.4}
              fill={INK}
              opacity={0.35}
            />
          ))}
          <rect x={13.3} y={20} width={5.4} height={7} rx={1} fill={COFFRE} />
          <rect x={15} y={22} width={2} height={2.6} rx={0.5} fill="#fff" />
        </>
      )
    default:
      return (
        <>
          <Line y={8} width={18} />
          <Line y={11} width={18} />
          <Line y={14} width={12} />
          <Line y={18} width={18} />
          <Line y={21} width={16} />
          <Line y={24} width={9} />
        </>
      )
  }
}

/** Étiquette : l'extension (4 lettres au plus), ou une flèche qui monte pendant l'envoi. */
function Label({ text, uploading }: { text: string; uploading?: boolean }) {
  if (uploading) {
    return (
      <g>
        <rect x={1} y={28.5} width={11} height={8.5} fill={COFFRE} />
        <g className="lift">
          <path
            d="M6.5 35.2v-4.4M4.4 32.9l2.1-2.1 2.1 2.1"
            fill="none"
            stroke="#fff"
            strokeWidth={1.1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </g>
    )
  }
  if (!text) return null
  const width = 4 + text.length * 4.05
  return (
    <g>
      <rect x={1} y={28.5} width={width} height={8.5} fill={COFFRE} />
      <text
        x={1 + width / 2}
        y={34.7}
        textAnchor="middle"
        fontSize={6.4}
        fontWeight={600}
        letterSpacing={0.2}
        fill="#fff"
        fontFamily="Geist Mono Variable, ui-monospace, monospace"
      >
        {text}
      </text>
    </g>
  )
}

/** La feuille d'un fichier (32 × 40). */
export function FileSheet({
  name,
  uploading,
  className
}: {
  name: string
  uploading?: boolean
  className?: string
}) {
  const kind = fileKind(name)
  const label = fileLabel(name)
  return (
    <svg viewBox="0 0 32 40" className={cn('block h-10 w-8', className)} aria-hidden="true">
      <path d="M5 3h18l7 7v29H5z" fill={INK} opacity={0.06} />
      <path
        d="M3.5 1.5h18l7 7v29h-25z"
        fill="#fff"
        stroke={INK}
        strokeOpacity={0.22}
        strokeLinejoin="round"
      />
      <path
        d="M21.5 1.5v7h7z"
        fill={FOLD}
        stroke={INK}
        strokeOpacity={0.22}
        strokeLinejoin="round"
      />
      <Drawing kind={kind} />
      <Label text={label} uploading={uploading} />
    </svg>
  )
}

/**
 * Coffre vide : des feuilles qui glissent dans le dossier violet du Coffre-fort, fermé
 * par le cadenas du chiffrement.
 */
export function DropIllustration({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 88 64" className={cn('block', className)} aria-hidden="true">
      <path
        d="M8 18.5a2.5 2.5 0 0 1 2.5-2.5h18l5 5h44a2.5 2.5 0 0 1 2.5 2.5v32a2.5 2.5 0 0 1-2.5 2.5h-67a2.5 2.5 0 0 1-2.5-2.5z"
        fill={COFFRE_INK}
      />
      <g transform="rotate(-9 35 18)">
        <rect x={25} y={5} width={20} height={26} fill="#fff" stroke={INK} strokeOpacity={0.2} />
        <rect x={28.5} y={9} width={13} height={1.5} fill={INK} opacity={0.16} />
        <rect x={28.5} y={12.5} width={13} height={1.5} fill={INK} opacity={0.16} />
        <rect x={28.5} y={16} width={9} height={1.5} fill={INK} opacity={0.16} />
      </g>
      <g transform="rotate(7 52 15)">
        <path
          d="M42 2.5h14l6 6v22H42z"
          fill="#fff"
          stroke={INK}
          strokeOpacity={0.2}
          strokeLinejoin="round"
        />
        <path
          d="M56 2.5v6h6z"
          fill={FOLD}
          stroke={INK}
          strokeOpacity={0.2}
          strokeLinejoin="round"
        />
        <rect x={45.5} y={7} width={7} height={2} fill={COFFRE} />
        <rect x={45.5} y={11.5} width={13} height={1.5} fill={INK} opacity={0.16} />
        <rect x={45.5} y={15} width={13} height={1.5} fill={INK} opacity={0.16} />
        <rect x={45.5} y={18.5} width={9} height={1.5} fill={INK} opacity={0.16} />
      </g>
      <path
        d="M6 27.5A2.5 2.5 0 0 1 8.5 25h71a2.5 2.5 0 0 1 2.5 2.5l-2.2 26.2a2.5 2.5 0 0 1-2.5 2.3H10.7a2.5 2.5 0 0 1-2.5-2.3z"
        fill={COFFRE}
      />
      <path d="M40.5 39v-2.6a3.5 3.5 0 0 1 7 0V39" fill="none" stroke="#fff" strokeWidth={1.6} />
      <rect x={38.5} y={38.5} width={11} height={8.5} rx={1.5} fill="#fff" />
      <circle cx={44} cy={41.9} r={1.3} fill={COFFRE} />
      <rect x={43.4} y={42.4} width={1.2} height={2.4} rx={0.4} fill={COFFRE} />
    </svg>
  )
}
