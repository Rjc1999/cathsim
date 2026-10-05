import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Silent background updates: the new worker takes over on the next load, never a prompt.
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'CathSim - Coronary Angiography Simulator',
        short_name: 'CathSim',
        description: 'Coronary fluoroscopy angle trainer for cath lab staff.',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Same artwork, the disc sits inside the maskable safe zone.
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the shell, bundles and every model (heart.glb, the lazy heart.veins.glb and the JSON indexes) for full offline use.
        globPatterns: ['**/*.{js,css,html,svg,png,glb,json,webmanifest}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  // three.js alone is ~700 KB minified; V0.1 ships one bundle, code-splitting is a later concern.
  build: { chunkSizeWarningLimit: 1300 },
})
