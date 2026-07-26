import type { GronkApi } from '../shared/types'

declare global {
  interface Window {
    gronk: GronkApi
  }

  /**
   * The app version, substituted at build time from package.json by
   * electron.vite.config.ts. Injected rather than written out so the number the
   * UI shows cannot drift from the one that gets released, which it already did
   * once: the sidebar read v0.2.0 while package.json said 0.1.0.
   */
  const __APP_VERSION__: string
}

export {}
