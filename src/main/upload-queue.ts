/*
 * File d'envoi de rclone (vfs/queue), à part pour être testée.
 *
 * rclone réessaie sans fin un envoi refusé, toutes les 5 min au plus, et le garde en attente.
 * Un seul refus déréglait l'application : envois « en attente » à vie, relevés à la seconde,
 * changements faits ailleurs retardés de 5 min (l'oubli des dossiers attend la fin des
 * envois), alerte pour un fichier que personne n'a déposé. Or le système écrit ses propres
 * fichiers dans les dossiers visités (.DS_Store, et un « ._ » par fichier dont il garde des
 * attributs étendus ; Thumbs.db, desktop.ini sous Windows), et le serveur les refuse là où
 * l'on ne peut pas déposer (Espace salariés, dossiers en lecture seule). D'où le tri :
 *  - un fichier du système refusé est effacé du lecteur, ce qui le retire de la file (le
 *    système le réécrit au besoin) ;
 *  - les fichiers temporaires des applications (verrous Office…) ne sont ni affichés ni
 *    signalés : ils disparaissent à la fermeture du document ;
 *  - seul ce qui avance compte comme envoi en cours ;
 *  - l'alerte nomme le fichier de l'utilisateur refusé, avec la raison lue dans le journal
 *    de rclone.
 */

/** Élément de `vfs/queue`. */
export interface QueueItem {
  /** Chemin dans le coffre (« Clients/Devis.pdf »). */
  name: string
  /** Essais d'envoi déjà faits : encore là après un essai, l'envoi a échoué. */
  tries: number
  uploading: boolean
}

export interface QueueSummary {
  /** Envois qui avancent : en cours, ou pas encore tentés (écriture différée). */
  active: number
  /** Fichiers de l'utilisateur en attente d'envoi (affichés). */
  pending: number
  /** Fichiers de l'utilisateur dont l'envoi a échoué (rclone réessaiera). */
  failing: string[]
  /** Fichiers du système refusés : à effacer du lecteur. */
  discard: string[]
}

export const EMPTY_QUEUE: QueueSummary = { active: 0, pending: 0, failing: [], discard: [] }

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

/** Fichier écrit par le système lui-même (Finder, Explorateur), jamais par l'utilisateur. */
export function isSystemFile(path: string): boolean {
  const name = baseName(path)
  return name === '.DS_Store' || name.startsWith('._') || /^(thumbs\.db|desktop\.ini)$/i.test(name)
}

/** Fichier temporaire d'application (motifs du serveur, config/drive.php). */
export function isTemporaryFile(path: string): boolean {
  return /^~\$|^\.~lock\..*#$|\.(tmp|crdownload|part)$/i.test(baseName(path))
}

export function summarizeQueue(items: QueueItem[]): QueueSummary {
  const summary: QueueSummary = { active: 0, pending: 0, failing: [], discard: [] }
  for (const item of items) {
    const failed = item.tries > 0 && !item.uploading
    if (!failed) summary.active += 1
    if (isSystemFile(item.name)) {
      if (failed) summary.discard.push(item.name)
    } else if (!isTemporaryFile(item.name)) {
      summary.pending += 1
      if (failed) summary.failing.push(item.name)
    }
  }
  return summary
}

/**
 * Dernière erreur d'envoi de chaque fichier, d'après le journal de rclone :
 * « ERROR : <chemin>: vfs cache: failed to upload try #N, will retry in …: <erreur> ».
 */
export function uploadErrors(log: string): Map<string, string> {
  const errors = new Map<string, string>()
  const line = /ERROR : (.+?): vfs cache: failed to upload try #\d+, will retry in [^:]+: (.*)$/gm
  for (const match of log.matchAll(line)) errors.set(match[1], match[2])
  return errors
}

/**
 * Raison d'un refus qui ne passera pas tout seul, ou null (coupure passagère : rclone
 * réessaie sans rien dire).
 */
export function refusalReason(error: string | undefined): string | null {
  const text = error ?? ''
  if (/\b507\b|insufficient storage|quota/i.test(text))
    return 'l’espace de stockage du coffre-fort est plein. Libérez de la place ou augmentez l’espace : l’envoi repartira de lui-même.'
  if (/\b413\b|too large|payload/i.test(text))
    return 'il dépasse la taille maximale d’un fichier du coffre-fort.'
  if (/\b403\b|forbidden/i.test(text))
    return 'votre compte ne peut pas ajouter ni modifier de fichiers dans ce dossier.'
  return null
}

/** Alerte pour les fichiers de l'utilisateur refusés par le serveur, ou null. */
export function refusalNotice(failing: string[], errors: Map<string, string>): string | null {
  const refused = failing.flatMap((name) => {
    const reason = refusalReason(errors.get(name))
    return reason ? [{ name, reason }] : []
  })
  if (refused.length === 0) return null
  const [first] = refused
  const file = `« ${baseName(first.name)} »`
  return refused.length === 1
    ? `${file} n’a pas été envoyé : ${first.reason}`
    : `${refused.length} fichiers n’ont pas été envoyés, dont ${file} : ${first.reason}`
}
