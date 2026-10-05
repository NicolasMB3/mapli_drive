import { baseName } from './format'

/** Famille d'un fichier, d'après son extension : elle choisit le dessin de sa feuille. */
export type FileKind =
  | 'pdf'
  | 'text'
  | 'sheet'
  | 'slides'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'other'

const EXTENSIONS: Record<Exclude<FileKind, 'other'>, string[]> = {
  pdf: ['pdf'],
  text: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'pages'],
  sheet: ['xls', 'xlsx', 'xlsm', 'ods', 'csv', 'numbers'],
  slides: ['ppt', 'pptx', 'odp', 'key'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'svg'],
  video: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz']
}

const KIND_BY_EXTENSION = new Map<string, FileKind>(
  Object.entries(EXTENSIONS).flatMap(([kind, extensions]) =>
    extensions.map((e) => [e, kind as FileKind] as const)
  )
)

/** « Clients/Devis Lenoir.PDF » → « pdf » ; rien pour un fichier sans extension (ni « .bashrc »). */
export function fileExtension(name: string): string {
  const base = baseName(name)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function fileKind(name: string): FileKind {
  return KIND_BY_EXTENSION.get(fileExtension(name)) ?? 'other'
}

/** Étiquette de la feuille : l'extension en capitales, quatre lettres au plus. */
export function fileLabel(name: string): string {
  return fileExtension(name).slice(0, 4).toUpperCase()
}
