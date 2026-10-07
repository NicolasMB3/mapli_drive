import type { ProxyEntry } from './proxy'

/*
 * Paramètres du montage rclone, à part pour être testés : Windows (lettre de lecteur,
 * WinFsp) et macOS (serveur NFS de rclone monté par le système), avec les mêmes réglages de
 * cache, de réseau et de journal (rcloneVfsArgs).
 *
 * Sécurité :
 *  - le token du poste et les identifiants du port de contrôle passent par
 *    l'environnement du processus, jamais par la ligne de commande (visible des autres
 *    utilisateurs de la machine) ;
 *  - le port de contrôle (rc) n'écoute que sur 127.0.0.1 et exige ces identifiants
 *    aléatoires, propres à chaque montage ;
 *  - le certificat TLS du serveur est vérifié (aucun --no-check-certificate) ;
 *  - rclone n'utilise pas la configuration personnelle de l'utilisateur (RCLONE_CONFIG).
 *
 * Réglages vérifiés contre la documentation de rclone 1.75.1 (version livrée) :
 *  - pas de --retries : il ne sert qu'aux commandes de copie (nouvel essai de toute
 *    l'opération) ; un montage s'appuie sur --low-level-retries (chaque requête) et sur les
 *    nouveaux essais propres au cache (envoi refait à intervalles croissants, jusqu'à 1 min) ;
 *  - pas de rotation du journal par rclone (--log-file-max-size) : elle cesse de rediriger
 *    la sortie d'erreur vers le journal, où arrivent les messages de WinFsp et les traces de
 *    plantage qu'explique explainFailure() (fs/log/log.go) — le journal reste borné par
 *    rclone-log.ts ;
 *  - pas de --vfs-fast-fingerprint : la taille et la date viennent de la liste du dossier
 *    (PROPFIND), rien de lent à éviter en WebDAV ;
 *  - pas de --poll-interval : le backend WebDAV ne signale pas les changements (ils
 *    arrivent par le temps réel et vfs/forget) ;
 *  - pas de --vfs-refresh : relire toute l'arborescence à chaque montage, c'est une
 *    requête par dossier, sur chaque poste, à chaque reconnexion ;
 *  - mode « lecteur réseau » (--network-mode) : à trancher par le banc
 *    (scripts/bench/windows-bench.ps1, profils « disque » et « reseau »).
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
  /**
   * Proxy du poste pour l'adresse du coffre, celui que résout Chromium pour l'API (réglages
   * du système, PAC, WPAD) : « http://hôte:port », null pour une connexion directe. Non
   * renseigné : l'environnement hérité reste tel quel. Sans lui, rclone (Go) ne lit que
   * HTTPS_PROXY et ignorait le proxy du système : l'API passait, le lecteur non.
   */
  proxy?: string | null
}

/** Espace laissé libre sur le disque du cache : au-delà, rclone évince ce qui n'est pas ouvert. */
export const CACHE_MIN_FREE_SPACE = '2G'

/**
 * Réglages communs aux montages Windows (WinFsp) et macOS (NFS) : cache, listes des
 * dossiers, réseau, port de contrôle, journal.
 */
export function rcloneVfsArgs(o: MountOptions): string[] {
  return [
    // Fichiers ouverts mis en cache localement, écrits sur le serveur 3 s après fermeture
    // (de quoi laisser une application finir d'enregistrer, sans faire attendre un dépôt).
    '--vfs-cache-mode',
    'full',
    '--vfs-cache-max-size',
    `${Math.max(1, Math.round(o.cacheSizeGb))}G`,
    '--vfs-cache-max-age',
    '24h',
    // Disque presque plein (le cache vit sur le disque du système) : rclone évince les
    // fichiers en cache non ouverts plutôt que de remplir le disque jusqu'au dernier octet.
    // Les envois en attente ne sont jamais évincés.
    '--vfs-cache-min-free-space',
    CACHE_MIN_FREE_SPACE,
    '--vfs-write-back',
    '3s',
    '--vfs-read-chunk-size',
    '32M',
    '--cache-dir',
    o.cacheDir,
    // Listes de dossiers gardées 10 min : les changements faits ailleurs (web, autres
    // postes) sont annoncés par le serveur, et seuls les dossiers touchés sont oubliés
    // (vfs/forget) ; sans temps réel, un changement de révision fait tout oublier.
    '--dir-cache-time',
    '10m',
    '--attr-timeout',
    '1s',
    '--vfs-case-insensitive',
    // --timeout borne aussi l'attente de la réponse à un envoi (ResponseHeaderTimeout de
    // Go) : le serveur doit avoir chiffré et rangé un fichier dans ce délai.
    '--timeout',
    '60s',
    '--contimeout',
    '30s',
    '--low-level-retries',
    '10',
    '--user-agent',
    o.userAgent,
    '--rc',
    '--rc-addr',
    `127.0.0.1:${o.rcPort}`,
    // Avertissements et erreurs seulement (journal borné à 10 Mo, voir rclone-log.ts).
    '--log-file',
    o.logFile,
    '--log-level',
    'NOTICE'
  ]
}

/** Montage Windows : une lettre de lecteur (WinFsp), au nom du volume « Mapli ». */
export function rcloneMountArgs(o: MountOptions): string[] {
  return ['mount', ':webdav:', o.mountPoint, '--volname', o.volumeName, ...rcloneVfsArgs(o)]
}

/**
 * Délai (s) après lequel macOS démonte d'office un volume resté muet (rclone arrêté net) :
 * les applications reçoivent une erreur au lieu de rester figées. L'application démonte
 * elle-même aussitôt quand rclone s'arrête ; ce délai est le filet de sécurité.
 */
export const NFS_DEAD_TIMEOUT_S = 45

/**
 * Montage macOS : rclone sert le coffre en NFS sur 127.0.0.1 et le client NFS du système le
 * monte (`rclone nfsmount`) — ni extension noyau (macFUSE), ni droits d'administrateur. Il
 * remplace le client WebDAV du Finder, qui envoyait des dizaines de requêtes et de verrous
 * par fichier copié (même serveur : 20 petits fichiers en 10 s et 793 requêtes, contre
 * 0,2 s, et 121 requêtes envoyées ensuite en arrière-plan). Le volume prend le nom de son
 * dossier (« Mapli »).
 */
export function rcloneNfsMountArgs(o: MountOptions): string[] {
  return [
    'nfsmount',
    ':webdav:',
    o.mountPoint,
    // IPv4 seulement : annoncé « localhost », le serveur était d'abord cherché en ::1.
    '--addr',
    '127.0.0.1:0',
    // Verrous tenus par le poste et pas de quotas : rclone ne sert ni NLM ni RQUOTA, et
    // chaque premier accès attendait sinon leur délai (46 s mesurées).
    '-o',
    'locallocks',
    '-o',
    'noquota',
    // rclone arrêté : les appels en cours échouent au lieu de figer le Finder (montage
    // interruptible), et le volume muet est démonté d'office.
    '-o',
    'intr',
    '-o',
    `deadtimeout=${NFS_DEAD_TIMEOUT_S}`,
    // Noms envoyés en forme composée (NFC), celle du coffre. Le Finder écrit souvent les
    // accents décomposés (NFD) : le serveur les recomposait, et rclone voyait le fichier
    // changer de nom à la relecture suivante du dossier.
    '-o',
    'nfc',
    ...rcloneVfsArgs(o)
  ]
}

/** Variables de proxy lues par Go (ProxyFromEnvironment), dans toutes les casses. */
const PROXY_VARIABLES = /^(https?|all|no)_proxy$/i

export function rcloneMountEnv(
  o: MountOptions,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  if (o.proxy !== undefined) {
    // Le proxy résolu pour l'API fait foi : un HTTPS_PROXY hérité (autre casse comprise,
    // l'environnement de Windows l'ignore) ne doit pas le contredire.
    for (const key of Object.keys(env)) if (PROXY_VARIABLES.test(key)) delete env[key]
    if (o.proxy) {
      env.HTTPS_PROXY = o.proxy
      env.HTTP_PROXY = o.proxy
    }
  }
  return {
    ...env,
    RCLONE_CONFIG: o.configFile,
    RCLONE_WEBDAV_URL: o.davUrl,
    // Façon ownCloud : rclone transmet la date de modification d'origine (X-OC-Mtime).
    RCLONE_WEBDAV_VENDOR: 'owncloud',
    RCLONE_WEBDAV_BEARER_TOKEN: o.token,
    RCLONE_RC_USER: o.rcUser,
    RCLONE_RC_PASS: o.rcPass
  }
}

/**
 * Proxy à donner à rclone d'après la réponse de Chromium (session.resolveProxy, lue par
 * parseProxyList) : la première entrée, comme Chromium. Go ne sait pas se rabattre sur
 * une autre entrée ; une connexion directe en tête donne null.
 */
export function rcloneProxy(entries: ProxyEntry[]): string | null {
  const first = entries[0]
  if (!first || first.kind === 'direct') return null
  const host = first.host.includes(':') ? `[${first.host}]` : first.host
  return `${first.kind}://${host}:${first.port}`
}
