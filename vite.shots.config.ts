/**
 * Vite config for the screenshot harness only. Not part of the app build, not
 * shipped, gitignored. See src/__shots.tsx.
 *
 * Run: npx vite --config vite.shots.config.ts
 */
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve('src'),
  resolve: {
    alias: {
      '@renderer': resolve('src'),
      '@shared': resolve('shared')
    }
  },
  define: {
    __APP_VERSION__: JSON.stringify('0.1.0')
  },
  plugins: [react()],
  server: {
    port: 5178,
    open: false
  }
})
