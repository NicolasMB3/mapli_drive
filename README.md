# Mapli Drive

Le coffre-fort [Mapli](https://mapli.fr) dans l’Explorateur Windows et le Finder macOS : un lecteur « Mapli » (M: par défaut sous Windows) où l’on glisse fichiers et dossiers — ils arrivent dans le coffre-fort de l’organisation, chiffrés, et tout ce qui est ajouté sur le web apparaît sur le poste.

## Ce que fait l’application

- **Appairage sans mot de passe** : un code « MAPL-XXXX » à approuver sur app.mapli.fr ; le poste reçoit un token d’appareil, chiffré par le système (DPAPI / trousseau), révocable depuis Mapli (Réglages → Sécurité → Appareils connectés).
- **Lecteur réseau** : Windows via [rclone](https://rclone.org/) + [WinFsp](https://winfsp.dev/) (cache local des fichiers ouverts, écriture différée de 5 s, reprise après coupure ou veille) ; macOS via le client WebDAV du Finder (volume « Mapli »).
- **Mêmes droits que le web** : permissions du membre, dossiers restreints, quotas ; suppression = corbeille (30 jours).
- **Zone de notification** : état du lecteur (pastille), ouverture du lecteur, pause, coffre-fort sur le web.
- **Mises à jour automatiques** depuis app.mapli.fr (`/downloads/drive/latest.yml`).

## Sécurité

- Token d’appareil : jamais en clair sur le disque, jamais sur la ligne de commande (transmis à rclone par l’environnement du processus).
- Port de contrôle de rclone limité à 127.0.0.1, protégé par des identifiants aléatoires propres à chaque montage.
- Certificat TLS du serveur vérifié ; rclone n’utilise pas la configuration personnelle de l’utilisateur.
- Fenêtre isolée (sandbox, contextIsolation, CSP stricte), pont IPC à liste fermée d’actions.
- Côté serveur : fichiers chiffrés par blocs (XChaCha20-Poly1305), une clé par fichier.

## Développement

```bash
npm install
npm run dev          # application (Electron), contre app.mapli.fr
npm run preview:ui   # interface seule dans un navigateur (maquette : ?etat=connecte, appairage, envoi…)
npm run lint && npm run typecheck && npm test
```

Contre un environnement local : `MAPLI_WEB_URL=http://localhost:3001 MAPLI_API_URL=http://localhost:8000/api/v1 npm run dev`.

Le montage Windows a besoin de `resources/rclone.exe` (téléchargé et vérifié par la CI au build) et de WinFsp installé.

## Publication

Pousser un tag `vX.Y.Z` (version alignée sur `package.json`, vérifiée par la CI) : la CI construit les installateurs Windows et macOS et les dépose sur `https://app.mapli.fr/downloads/drive/` — fichiers versionnés et `latest.yml` / `latest-mac.yml` pour les mises à jour des postes, plus `Mapli-Drive-Setup.exe` et `Mapli-Drive.dmg`, la dernière version sous un nom fixe, vers lesquels pointe le coffre-fort web. Rien ne dépend de GitHub côté postes : le dépôt peut rester privé.

Secrets de la CI : `DRIVE_DEPLOY_KEY` (clé SSH propre à ce dépôt, limitée sur le serveur par `rrsync -wo` à l'écriture dans `/mnt/data/mapli/downloads/drive`, sans shell), `DRIVE_DEPLOY_HOST`, `DRIVE_DEPLOY_USER` et `DRIVE_DEPLOY_KNOWN_HOSTS` (clé d'hôte du serveur, vérifiée). Le serveur garde les trois dernières versions (`/etc/cron.daily/mapli-drive-prune`).

## Architecture

```
src/
├── main/                  # Processus principal (Node)
│   ├── index.ts           # Fenêtre, zone de notification, IPC
│   ├── controller.ts      # État du lecteur : appairage, montage, reconnexion
│   ├── pairing.ts         # Appairage (Device Authorization Grant)
│   ├── drive-mount.ts     # Montage rclone (Windows) / Finder (macOS)
│   ├── rclone-args.ts     # Paramètres de montage (testés)
│   ├── api.ts             # API Mapli
│   ├── session.ts         # Token chiffré + réglages
│   ├── tray.ts            # Zone de notification
│   └── updater.ts         # Mises à jour
├── preload/               # Pont IPC (contextBridge)
├── renderer/              # Interface React (charte « Papier »)
└── shared/                # Types et canaux IPC
```
