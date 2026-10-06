/*
 * Paramètres du montage rclone (Windows), à part pour être testés.
 *
 * Sécurité :
 *  - le token du poste et les identifiants du port de contrôle passent par
 *    l'environnement du processus, jamais par la ligne de commande (visible des autres
 *    utilisateurs de la machine) ;
 *  - le port de contrôle (rc) n'écoute que sur 127.0.0.1 et exige ces identifiants
 *    aléatoires, propres à chaque montage ;
 *  - le certificat TLS du serveur est vérifié (aucun --no-check-certificate) ;
 *  - rclone n'utilise pas la configuration personnelle de l'utilisateur (RCLONE_CONFIG).
 */

export interface MountOptions {
  davUrl: string
  token: string
  mountPoint: string
  volumeName: string
  rcPort: number
  rcUser: string
  rcPass: string
  cacheDir: string
  cacheSizeGb: number
  logFile: string
  configFile: string
  userAgent: string
}

export function rcloneMountArgs(o: MountOptions): string[] {
  return [
    'mount',
    ':webdav:',
    o.mountPoint,
    // Fichiers ouverts mis en cache localement, écrits sur le serveur 3 s après fermeture
    // (de quoi laisser une application finir d'enregistrer, sans faire attendre un dépôt).
    '--vfs-cache-mode',
    'full',
    '--vfs-cache-max-size',
    `${Math.max(1, Math.round(o.cacheSizeGb))}G`,
    '--vfs-cache-max-age',
    '24h',
    '--vfs-write-back',
    '3s',
    '--vfs-read-chunk-size',
    '32M',
    '--cache-dir',
    o.cacheDir,
    // Les changements faits ailleurs (web, autres postes) apparaissent sous 30 s.
    '--dir-cache-time',
    '30s',
    '--attr-timeout',
    '1s',
    '--vfs-case-insensitive',
    '--volname',
    o.volumeName,
    '--timeout',
    '60s',
    '--contimeout',
    '30s',
    '--retries',
    '5',
    '--low-level-retries',
    '10',
    '--user-agent',
    o.userAgent,
    '--rc',
    '--rc-addr',
    `127.0.0.1:${o.rcPort}`,
    '--log-file',
    o.logFile,
    '--log-level',
    'INFO'
  ]
}

export function rcloneMountEnv(
  o: MountOptions,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...base,
    RCLONE_CONFIG: o.configFile,
    RCLONE_WEBDAV_URL: o.davUrl,
    // Façon ownCloud : rclone transmet la date de modification d'origine (X-OC-Mtime).
    RCLONE_WEBDAV_VENDOR: 'owncloud',
    RCLONE_WEBDAV_BEARER_TOKEN: o.token,
    RCLONE_RC_USER: o.rcUser,
    RCLONE_RC_PASS: o.rcPass
  }
}
