/*
 * Suivi des envois de rclone, à part pour être testé : à quel rythme relever ses
 * statistiques, et quand un envoi vient de se terminer. Un fichier déposé dans le dossier
 * d'un salarié doit faire apparaître la petite fenêtre « Publier ? » dès son arrivée sur
 * le serveur, pas au prochain passage de la révision (20 s).
 */

export interface UploadSnapshot {
  /** Transferts en cours. */
  transfers: number
  /** Envois en attente (écriture différée) ou en cours. */
  pendingUploads: number
  /** Transferts terminés depuis le démarrage de rclone (compteur cumulé). */
  completed: number
}

/** Relevé rapproché : fenêtre ouverte, ou un envoi attend ou part. */
export const STATS_ACTIVE_MS = 1_000

/**
 * Sinon, plus court que l'écriture différée de rclone (--vfs-write-back) : un fichier
 * déposé reste au moins ce temps-là en attente, aucun dépôt n'échappe donc au suivi.
 */
export const STATS_IDLE_MS = 2_500

const busy = (s: UploadSnapshot): boolean => s.transfers > 0 || s.pendingUploads > 0

export function statsDelay(windowVisible: boolean, current: UploadSnapshot): number {
  return windowVisible || busy(current) ? STATS_ACTIVE_MS : STATS_IDLE_MS
}

/**
 * Un envoi vient-il de se terminer ? Plus rien n'attend ni ne part, et quelque chose
 * attendait ou partait au relevé précédent — ou le compteur de rclone a avancé entre deux
 * relevés (un petit fichier envoyé en un éclair). Compteur revenu en arrière : rclone a
 * redémarré, ce n'est pas un envoi.
 */
export function uploadsSettled(previous: UploadSnapshot, next: UploadSnapshot): boolean {
  return !busy(next) && (busy(previous) || next.completed > previous.completed)
}
