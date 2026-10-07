/**
 * Nom du lecteur à afficher : la lettre sous Windows (« M: »), « Mapli » sous macOS — le
 * volume s'appelle ainsi dans le Finder ; son dossier de montage (dans le profil de
 * l'application) ne dit rien à personne.
 */
export function driveLabel(mountPoint: string): string {
  return mountPoint.startsWith('/') ? 'Mapli' : mountPoint
}
