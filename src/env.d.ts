import type { GronkApi } from '../shared/types'

declare global {
  interface Window {
    gronk: GronkApi
  }

  /**
   * Semver from package.json, substituted at build time by electron.vite.config.ts.
   * Not unique across nightlies that share the same package version.
   */
  const __APP_VERSION__: string

  /**
   * What the sidebar footer shows: package version, channel when not stable,
   * and a short commit sha. Two builds of "0.2.0" must not look identical.
   * Built by scripts/build-label.mjs via electron.vite.config.ts.
   */
  const __APP_BUILD_LABEL__: string
}

export {}
