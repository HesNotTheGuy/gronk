import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Every IPC handler must call assertTrustedSender before it does anything.
 *
 * CONTRIBUTING.md already states this and says "the handler count and the guard
 * count are expected to match", but nothing enforced it. A documented rule with
 * no test is a rule that survives exactly until someone is in a hurry.
 *
 * This matters more now the repo takes pull requests from strangers. A reviewer,
 * human or otherwise, can be talked out of an opinion by a persuasive pull
 * request. A count cannot be talked out of anything. Any invariant that can be
 * machine-checked should be, because that is the part of review immune to both
 * fatigue and manipulation.
 *
 * Checked per handler rather than by total, because 60 handlers and 60 guards
 * also describes a file where one handler has two guards and another has none.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IPC_DIR = path.join(ROOT, 'electron/main')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

interface Handler {
  file: string
  channel: string
  body: string
}

/**
 * Split each file on `ipcMain.handle(` and treat what follows, up to the next
 * registration, as that handler's body. Crude, and deliberately so: a parser
 * that understood the code could be fooled by clever code, which is the opposite
 * of what this test is for.
 */
function findHandlers(marker: string): Handler[] {
  const handlers: Handler[] = []
  for (const file of sourceFiles(IPC_DIR)) {
    const source = fs.readFileSync(file, 'utf8')
    const parts = source.split(marker)
    for (let i = 1; i < parts.length; i++) {
      const body = parts[i]
      const channel = body.match(/^\s*['"`]([^'"`]+)['"`]/)?.[1] ?? `(unnamed #${i})`
      handlers.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), channel, body })
    }
  }
  return handlers
}

test('the scan finds the handlers it is supposed to be checking', () => {
  const handlers = findHandlers('ipcMain.handle(')
  // Vacuity guard. If registration is refactored so this marker stops matching,
  // the per-handler test below would pass over an empty list and report the
  // codebase as perfectly guarded.
  assert.ok(
    handlers.length > 40,
    `expected to find many IPC handlers, found ${handlers.length}. If registration changed shape, update this test rather than deleting it.`
  )
})

test('every ipcMain.handle calls assertTrustedSender', () => {
  const offenders = findHandlers('ipcMain.handle(')
    .filter((h) => !h.body.includes('assertTrustedSender'))
    .map((h) => `${h.file}  ${h.channel}`)

  assert.deepEqual(
    offenders,
    [],
    `these IPC handlers never call assertTrustedSender, so any web content that ` +
      `reaches the bridge can invoke them:\n  ${offenders.join('\n  ')}`
  )
})

test('no ipcMain.on handler exists at all', () => {
  // Stricter than "must be guarded", on purpose. `on` has no return channel, so
  // the throw from assertTrustedSender goes nowhere: the caller sees no error
  // and the handler body has already run. A guarded `ipcMain.on` therefore looks
  // protected in review while providing no protection at all, which is worse
  // than an obviously unguarded one. Every channel here uses `handle`.
  const found = findHandlers('ipcMain.on(').map((h) => `${h.file}  ${h.channel}`)

  assert.deepEqual(
    found,
    [],
    `ipcMain.on found. Use ipcMain.handle instead, so a rejected sender actually ` +
      `fails the call:\n  ${found.join('\n  ')}`
  )
})

test('the guard is the first thing each handler does', () => {
  // Ordering matters. A handler that validates arguments, touches the store, or
  // spawns anything before checking the sender has already acted on a request
  // it was going to reject.
  const late: string[] = []
  for (const h of findHandlers('ipcMain.handle(')) {
    const guardAt = h.body.indexOf('assertTrustedSender')
    if (guardAt === -1) continue // reported by the test above

    const before = h.body.slice(0, guardAt)
    // Anything that reads renderer input or reaches outside the process.
    for (const risky of ['assertString(', 'assertCliName(', 'readStore(', 'spawn(', 'fs.']) {
      if (before.includes(risky)) {
        late.push(`${h.file}  ${h.channel}  (${risky.replace('(', '')} runs before the guard)`)
        break
      }
    }
  }
  assert.deepEqual(late, [], `guard runs too late in:\n  ${late.join('\n  ')}`)
})
