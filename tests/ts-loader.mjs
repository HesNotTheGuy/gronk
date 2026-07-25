/**
 * Lets `node --test` load the app's TypeScript sources directly.
 *
 * Node 22.18+/24 strips types natively, but it will not guess an extension the
 * way a bundler does. Our source uses bundler-style extensionless relative
 * imports (`import { redactSecrets } from './redact'`), so this hook appends
 * `.ts` when the extensionless file exists. Zero dependencies on purpose — the
 * repo does not take new npm packages without a supply-chain check (SECURITY.md).
 *
 * Only `.ts` is resolved: `.tsx` cannot be type-stripped by Node, which is why
 * testable logic lives in plain `.ts` modules (src/lib/*, electron/main/*-map.ts)
 * rather than inside components.
 */
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * `electron` is a native binary that cannot be imported outside an Electron
 * process, so main-process modules that only need `app.getPath` are redirected
 * to a stub. Tests import the same stub to configure it — the module cache makes
 * both sides the one instance.
 */
const ELECTRON_STUB = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'stubs', 'electron.ts')).href

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      return { url: ELECTRON_STUB, shortCircuit: true }
    }
    const relative = specifier.startsWith('./') || specifier.startsWith('../')
    const hasExtension = /\.[a-z0-9]+$/i.test(specifier)
    if (relative && !hasExtension && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(candidate))) {
        return { url: candidate.href, shortCircuit: true }
      }
      const index = new URL(`${specifier}/index.ts`, context.parentURL)
      if (existsSync(fileURLToPath(index))) {
        return { url: index.href, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  }
})
