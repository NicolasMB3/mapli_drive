# Contribuer à Mapli Drive

## Mise en route

```bash
git clone git@github.com:NicolasMB3/mapli_drive.git
cd mapli_drive
npm install
npm run dev
```

## Avant chaque envoi

```bash
npm run lint
npm run typecheck
npm test
npx electron-vite build
```

La CI rejoue ces étapes à chaque envoi sur `dev` et `main`.

## Conventions

- **TypeScript strict** — pas de `any`, pas de `@ts-ignore`.
- **Types partagés** — dans `src/shared/types.ts` ; l’API exposée à la fenêtre dans `src/shared/bridge.ts`.
- **Canaux IPC** — toujours les constantes de `src/shared/ipc-channels.ts`.
- **Interface** — charte « Papier » de Mapli (encre, filets, surtitres mono, violet du Coffre-fort) via les jetons Tailwind de `src/renderer/src/index.css`. L’aperçu navigateur (`npm run preview:ui`) montre chaque état.
- **Sécurité** — aucun secret sur la ligne de commande ni en clair sur le disque ; la fenêtre reste isolée (sandbox, CSP).
- **Commits** — en français, `type(portée): message` (`feat`, `fix`, `style`, `refactor`, `chore`, `ci`, `docs`), avec un corps qui explique le pourquoi.
