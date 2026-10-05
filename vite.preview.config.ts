import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/*
 * Aperçu de l'interface dans un navigateur (mise au point, captures) : la fenêtre sans
 * Electron, alimentée par la maquette de lib/bridge.ts (?etat=connecte, appairage…).
 *   npx vite --config vite.preview.config.ts
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  plugins: [react(), tailwindcss()],
  server: { port: 5180, strictPort: true },
})
