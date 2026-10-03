import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // three.js alone is ~700 KB minified; V0.1 ships one bundle, code-splitting is a later concern.
  build: { chunkSizeWarningLimit: 1300 },
})
