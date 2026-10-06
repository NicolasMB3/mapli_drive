import { describe, expect, it } from 'vitest'
import { ApiError, NetworkError, UserFacingError } from '../errors'
import {
  frenchOr,
  looksFrench,
  OFFLINE_MESSAGE,
  toUserMessage,
  UNEXPECTED_MESSAGE,
  type ErrorContext
} from '../user-message'

/** Erreur système de Node (code « EACCES », « ENOTFOUND »…), message en anglais. */
const systemError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code })

const FRENCH_SERVER_MESSAGES = [
  'Vous n’avez pas accès au coffre-fort de Maison Verdier. Demandez l’accès à un administrateur.',
  "Vous n'avez pas les droits pour publier dans cet espace.",
  'Toutes les places de votre offre sont prises (40 sur 40).',
  'Le champ e-mail doit être une adresse e-mail valide.',
  'Cet e-mail est déjà utilisé par un autre compte.',
  'Ce code a expiré.',
  '2 documents publiés dans l’espace de Jean Dupont, prévenu par e-mail.',
  '« Jean DUPONT » reste un simple dossier.',
  "Accès créé — un lien d'activation a été envoyé à jean.dupont@exemple.fr."
]

// Ce que renvoient un framework (Laravel, Symfony), un proxy ou une base de données.
const ENGLISH_SERVER_MESSAGES = [
  'Unauthenticated.',
  'This action is unauthorized.',
  'Too Many Attempts.',
  'Server Error',
  'Service Unavailable',
  'Not Found',
  'Forbidden',
  'Bad Gateway',
  'Gateway Timeout',
  'CSRF token mismatch.',
  'The given data was invalid.',
  'The email field must be a valid email address. (and 2 more errors)',
  'The selected request_ids.0 is invalid.',
  'No query results for model [App\\Models\\Folder] 0199d5b0-4e8d-7a1f-9c2d-1e2f3a4b5c6d',
  'The route api/v1/desktop/app/drive could not be found.',
  'The GET method is not supported for route api/v1/desktop/pairing/poll. Supported methods: POST.',
  'Attempt to read property "id" on null',
  "SQLSTATE[23000]: Integrity constraint violation: 1062 Duplicate entry 'rené@exemple.fr' for key 'users_email_unique'"
]

describe('messages d’erreur montrés à l’utilisateur', () => {
  it('garde le message du serveur quand il est en français', () => {
    for (const message of FRENCH_SERVER_MESSAGES) {
      expect(toUserMessage(new ApiError(422, message), 'space')).toBe(message)
    }
  })

  it('remplace un message anglais du serveur par une phrase française, selon le statut', () => {
    expect(toUserMessage(new ApiError(401, 'Unauthenticated.'), 'space')).toBe(
      'Ce poste n’est plus autorisé par Mapli. Reliez-le à nouveau.'
    )
    expect(toUserMessage(new ApiError(403, 'This action is unauthorized.'), 'connect')).toBe(
      'Accès refusé. Demandez l’accès à un administrateur de votre organisation.'
    )
    expect(toUserMessage(new ApiError(404, 'No query results for model'), 'space')).toBe(
      'Introuvable : ce document ou ce dossier a peut-être déjà été traité.'
    )
    expect(toUserMessage(new ApiError(422, 'The given data was invalid.'), 'space')).toBe(
      'Certaines informations ne sont pas valides. Vérifiez-les, puis réessayez.'
    )
    expect(toUserMessage(new ApiError(429, 'Too Many Attempts.'), 'pairing')).toBe(
      'Trop de tentatives. Patientez un instant, puis réessayez.'
    )
    expect(toUserMessage(new ApiError(500, 'Server Error'), 'connect')).toBe(
      'Mapli a rencontré un problème. Réessayez dans quelques minutes.'
    )
    expect(toUserMessage(new ApiError(503, 'Service Unavailable'))).toBe(
      'Mapli est momentanément indisponible. Réessayez dans quelques minutes.'
    )
    expect(toUserMessage(new ApiError(504, 'Gateway Timeout'))).toBe(
      'Mapli met trop de temps à répondre. Réessayez dans un instant.'
    )
  })

  it('parle selon le statut quand le serveur ne dit rien (page HTML d’un proxy, réponse vide)', () => {
    expect(toUserMessage(new ApiError(502), 'connect')).toBe(
      'Mapli est momentanément indisponible. Réessayez dans quelques minutes.'
    )
    expect(toUserMessage(new ApiError(413, '  '), 'space')).toBe(
      'La demande est trop volumineuse pour Mapli.'
    )
    expect(toUserMessage(new ApiError(400), 'pairing')).toBe(
      'L’appairage n’a pas abouti. Réessayez dans un instant.'
    )
    expect(toUserMessage(new ApiError(401), 'pairing')).toBe(
      'L’appairage n’a pas abouti. Réessayez dans un instant.'
    )
    expect(toUserMessage(new ApiError(418))).toBe(UNEXPECTED_MESSAGE)
  })

  it('dit que Mapli est injoignable pour toute coupure du réseau', () => {
    expect(toUserMessage(new NetworkError('net::ERR_INTERNET_DISCONNECTED'), 'connect')).toBe(
      OFFLINE_MESSAGE
    )
    expect(toUserMessage(systemError('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:443'))).toBe(
      OFFLINE_MESSAGE
    )
    expect(toUserMessage(systemError('ENOTFOUND', 'getaddrinfo ENOTFOUND app.mapli.fr'))).toBe(
      OFFLINE_MESSAGE
    )
    expect(toUserMessage(systemError('ETIMEDOUT', 'connect ETIMEDOUT'), 'space')).toBe(
      OFFLINE_MESSAGE
    )
    expect(toUserMessage(new TypeError('fetch failed'), 'pairing')).toBe(OFFLINE_MESSAGE)
    expect(toUserMessage(new Error('net::ERR_NAME_NOT_RESOLVED'), 'connect')).toBe(OFFLINE_MESSAGE)
  })

  it('traduit les erreurs du système de fichiers', () => {
    expect(
      toUserMessage(
        systemError('EACCES', "EACCES: permission denied, open 'C:\\Mapli Drive\\rclone.conf'"),
        'connect'
      )
    ).toBe('Accès refusé par le système de ce poste. Redémarrez-le, puis réessayez.')
    expect(toUserMessage(systemError('EPERM', 'EPERM: operation not permitted'), 'pairing')).toBe(
      'Accès refusé par le système de ce poste. Redémarrez-le, puis réessayez.'
    )
    expect(toUserMessage(systemError('ENOSPC', 'ENOSPC: no space left on device'))).toBe(
      'Le disque de ce poste est plein. Libérez de la place, puis réessayez.'
    )
    expect(toUserMessage(systemError('EBUSY', 'EBUSY: resource busy or locked'))).toBe(
      'Un fichier de Mapli Drive est utilisé par un autre programme. Réessayez dans un instant.'
    )
  })

  it('montre tels quels les messages écrits pour l’utilisateur', () => {
    const error = new UserFacingError('Le composant WinFsp est manquant. Réinstallez Mapli Drive.')
    expect(toUserMessage(error, 'connect')).toBe(error.message)
  })

  it('ne montre jamais le texte d’une erreur imprévue : une phrase selon le contexte', () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'organization')")
    expect(toUserMessage(bug, 'connect')).toBe(
      'Le lecteur n’a pas pu être monté. Réessayez dans un instant.'
    )
    expect(toUserMessage(bug, 'pairing')).toBe(
      'L’appairage n’a pas abouti. Réessayez dans un instant.'
    )
    expect(toUserMessage(bug, 'space')).toBe('L’action n’a pas abouti. Réessayez dans un instant.')
    expect(toUserMessage(bug)).toBe(UNEXPECTED_MESSAGE)
    expect(toUserMessage('Something went wrong', 'space')).toBe(
      'L’action n’a pas abouti. Réessayez dans un instant.'
    )
    expect(toUserMessage(null)).toBe(UNEXPECTED_MESSAGE)
    expect(toUserMessage(new UserFacingError(''))).toBe(UNEXPECTED_MESSAGE)
  })

  it('répond toujours en français, quelle que soit l’erreur', () => {
    const errors: unknown[] = [
      ...ENGLISH_SERVER_MESSAGES.map((message) => new ApiError(400, message)),
      ...[401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504].map((s) => new ApiError(s)),
      new NetworkError('Failed to fetch'),
      systemError('EACCES', 'EACCES: permission denied'),
      systemError('EADDRINUSE', 'listen EADDRINUSE: address already in use 127.0.0.1:5572'),
      new Error('Port indisponible'),
      new SyntaxError('Unexpected token < in JSON at position 0'),
      undefined
    ]
    const contexts: (ErrorContext | undefined)[] = ['pairing', 'connect', 'space', undefined]
    for (const error of errors) {
      for (const context of contexts) {
        expect(looksFrench(toUserMessage(error, context))).toBe(true)
      }
    }
  })
})

describe('looksFrench', () => {
  it('reconnaît le français, avec ou sans accents, apostrophe droite ou courbe', () => {
    for (const message of FRENCH_SERVER_MESSAGES) expect(looksFrench(message)).toBe(true)
    expect(looksFrench('Code invalide ou expire')).toBe(true)
    expect(looksFrench('ECHEC DE LA PUBLICATION')).toBe(true)
  })

  it('écarte l’anglais, même parsemé de noms accentués ou d’identifiants', () => {
    for (const message of ENGLISH_SERVER_MESSAGES) expect(looksFrench(message)).toBe(false)
    expect(looksFrench('The user René Lefèvre does not exist.')).toBe(false)
  })

  it('dans le doute (rien de reconnaissable), répond non', () => {
    expect(looksFrench('')).toBe(false)
    expect(looksFrench('OK')).toBe(false)
    expect(looksFrench('HTTP 500')).toBe(false)
  })
})

describe('frenchOr', () => {
  it('garde un message français du serveur, sinon la phrase prévue', () => {
    const done = 'Documents publiés dans son espace.'
    expect(frenchOr('2 documents publiés dans l’espace de Jean Dupont.', done)).toBe(
      '2 documents publiés dans l’espace de Jean Dupont.'
    )
    expect(frenchOr('  Ce dossier reste un simple dossier.  ', done)).toBe(
      'Ce dossier reste un simple dossier.'
    )
    expect(frenchOr('Documents published.', done)).toBe(done)
    expect(frenchOr('', done)).toBe(done)
    expect(frenchOr(undefined, done)).toBe(done)
    expect(frenchOr({ message: 'Publié' }, done)).toBe(done)
  })
})
