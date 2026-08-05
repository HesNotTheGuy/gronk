import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { formatBuildLabel, resolveBuildChannel } from './shared/build-label'

/** Package version from package.json (semver). Not unique across nightlies. */
const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
  version: string
}

function shortCommit(): string {
  const fromCi = process.env.GITHUB_SHA?.trim()
  if (fromCi) return fromCi.slice(0, 7)
  try {
    return execSync('git rev-parse --short=7 HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return 'unknown'
  }
}

const commit = shortCommit()
const channel = resolveBuildChannel({
  githubRef: process.env.GITHUB_REF,
  githubRefName: process.env.GITHUB_REF_NAME,
  githubEventName: process.env.GITHUB_EVENT_NAME,
  channelOverride: process.env.GRONK_CHANNEL,
  ci: process.env.CI === 'true' || process.env.CI === '1'
})
/** What the sidebar shows: distinguishes nightly vs stable and two builds of the same package version. */
const buildLabel = formatBuildLabel({ version, commit, channel })

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('electron/main'),
        '@shared': resolve('shared')
      }
    },
    build: {
      lib: {
        // electron-vite 3 defaults to src/main; we keep electron/main
        entry: resolve('electron/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('shared')
      }
    },
    build: {
      lib: {
        entry: resolve('electron/preload/index.ts')
      }
    }
  },
  renderer: {
    root: resolve('src'),
    resolve: {
      alias: {
        '@renderer': resolve('src'),
        '@shared': resolve('shared')
      }
    },
    define: {
      __APP_VERSION__: JSON.stringify(version),
      __APP_BUILD_LABEL__: JSON.stringify(buildLabel)
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve('src/index.html')
      }
    }
  }
})
