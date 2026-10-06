/*
 * Erreurs du processus principal, à part (sans Electron) pour être testées avec ce que la
 * fenêtre en dit (user-message.ts).
 */

/** Réponse d'erreur de l'API Mapli : son statut HTTP, et le message du serveur s'il y en a un. */
export class ApiError extends Error {
  name = 'ApiError'

  constructor(
    public readonly status: number,
    /** Tel que renvoyé : pas toujours en français (framework, proxy). Voir toUserMessage. */
    public readonly serverMessage: string | null = null
  ) {
    super(serverMessage || `HTTP ${status}`)
  }
}

/** Réseau ou serveur injoignable (par opposition à une réponse d'erreur du serveur). */
export class NetworkError extends Error {
  name = 'NetworkError'
}

/** Erreur dont le message, en français, est écrit pour être lu tel quel dans la fenêtre. */
export class UserFacingError extends Error {
  name = 'UserFacingError'
}
