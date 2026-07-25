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
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
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
