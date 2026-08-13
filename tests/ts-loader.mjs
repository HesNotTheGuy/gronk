/**
 * Lets `node --test` load the app's TypeScript sources directly.
 *
 * Node 22.18+ strips types natively, but it will not guess an extension the way
 * a bundler does. Our source uses bundler-style extensionless relative imports
 * (`import { redactSecrets } from './redact'`), so this hook appends `.ts` or
 * `.tsx` when the file exists.
 *
 * Node cannot strip JSX, so `.tsx` is compiled here with esbuild instead. That
 * is not a new dependency: esbuild already ships inside vite, which the app
 * builds with. Without this, components could not be tested at all, and the
 * two worst bugs this project has shipped were both in the renderer.
 */
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { transformSync } from 'esbuild'

// React reads this when it loads, so it has to be set before any test module is
// imported. Setting it from inside a helper is too late and every act() call warns.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

/**
 * `electron` is a native binary that cannot be imported outside an Electron
 * process, so main-process modules that only need `app.getPath` are redirected
 * to a stub. Tests import the same stub to configure it — the module cache makes
 * both sides the one instance.
 */
const ELECTRON_STUB = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'stubs', 'electron.ts')).href

/** Extensions tried for an extensionless relative import, in order. */
const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx']

/**
 * The two path aliases the app builds with, from `electron.vite.config.ts` and
 * `tsconfig.web.json`. Without them a component that imports `@shared/path` cannot be
 * mounted in a test at all — the import throws before the file is read, and the failure
 * reads as a missing npm package rather than as a resolver gap.
 */
const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]tests$/, '')
const ALIASES = [
  ['@shared/', join(ROOT, 'shared')],
  ['@renderer/', join(ROOT, 'src')]
]

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { url: ELECTRON_STUB, shortCircuit: true }
    }
    for (const [prefix, dir] of ALIASES) {
      if (!specifier.startsWith(prefix)) continue
      const base = pathToFileURL(join(dir, specifier.slice(prefix.length))).href
      for (const ext of ['', ...EXTENSIONS]) {
        if (existsSync(fileURLToPath(`${base}${ext}`))) {
          return { url: `${base}${ext}`, shortCircuit: true }
        }
      }
    }
    const relative = specifier.startsWith('./') || specifier.startsWith('../')
    const hasExtension = /\.[a-z0-9]+$/i.test(specifier)
    if (relative && !hasExtension && context.parentURL) {
      for (const ext of EXTENSIONS) {
        const candidate = new URL(`${specifier}${ext}`, context.parentURL)
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true }
        }
      }
    }
    // CSS imported by a component is a bundler concern with nothing to assert
    // in a test. Resolve it to an empty module rather than letting the import
    // throw and take the whole suite down.
    if (relative && /\.css$/i.test(specifier) && context.parentURL) {
      return { url: 'data:text/javascript,export default {}', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },

  load(url, context, nextLoad) {
    if (!url.endsWith('.tsx')) return nextLoad(url, context)
    const path = fileURLToPath(url)
    const { code } = transformSync(readFileSync(path, 'utf8'), {
      loader: 'tsx',
      format: 'esm',
      target: 'node22',
      // Classic runtime would need React in scope in every file; the automatic
      // runtime imports jsx-runtime itself, matching how vite builds the app.
      jsx: 'automatic',
      sourcefile: path
    })
    return { format: 'module', source: code, shortCircuit: true }
  }
})
