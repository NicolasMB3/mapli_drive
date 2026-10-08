/** macOS : les fenêtres gardent les boutons ronds du système (fermer, réduire), à gauche. */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Macintosh|Mac OS X/.test(navigator.userAgent)
