import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { installFakeBridge } from './helpers/gronk-api'

/**
 * The fake bridge must expose exactly what the real preload exposes.
 *
 * Every renderer test runs against `installFakeBridge`, so the fake IS the
 * contract those tests validate against. When the real preload gains a method
 * and the fake does not, the tests keep passing while validating a fiction.
 *
 * That is not hypothetical. `previewPopOut`, `previewDock` and `listSkills`
 * shipped in the real bridge and were missing here for two releases. Nothing
 * failed, because the hooks wrap them in closures that the tests check for
 * existence but never call:
 *
 *   popOutPreview: () => window.gronk.previewPopOut()
 *
 * use-gronk-surface.test.ts confirms `popOutPreview` is a function. Calling it
 * would have thrown "previewPopOut is not a function". Nothing called it.
 *
 * Reading the preload as text rather than importing it is deliberate: it calls
 * contextBridge.exposeInMainWorld at module scope, which throws outside a real
 * preload context.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PRELOAD = path.join(ROOT, 'electron/preload/index.ts')

/**
 * Method names from the object literal handed to contextBridge.
 *
 * Anchored at exactly two spaces so nested object properties, which sit deeper,
 * cannot be mistaken for top-level bridge members.
 */
function realBridgeMembers(): Set<string> {
  const source = fs.readFileSync(PRELOAD, 'utf8')
  // The object is declared first and handed to contextBridge afterwards, so
  // slice between `const api = {` and its closing brace at column 0 rather than
  // from the exposeInMainWorld call, which comes after everything.
  const start = source.indexOf('const api')
  assert.notEqual(start, -1, 'preload no longer declares `const api`')
  const body = source.slice(start)
  const end = body.search(/^\}/m)
  assert.notEqual(end, -1, 'could not find the end of the api object')

  assert.ok(
    source.includes('exposeInMainWorld'),
    'preload no longer calls exposeInMainWorld; this parser is measuring the wrong thing'
  )

  const members = new Set<string>()
  for (const match of body.slice(0, end).matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\s*:/gm)) {
    members.add(match[1])
  }
  return members
}

function fakeBridgeMembers(): Set<string> {
  const bridge = installFakeBridge()
  try {
    const api = (globalThis as Record<string, unknown>).gronk as Record<string, unknown>
    return new Set(Object.keys(api))
  } finally {
    bridge.restore()
  }
}

test('the parser finds a plausible bridge surface', () => {
  const real = realBridgeMembers()
  // Guards the regex itself. If the preload is reformatted so the anchor stops
  // matching, this fails loudly instead of reporting an empty set as parity.
  assert.ok(real.size > 40, `expected a large bridge, parsed ${real.size} members`)
  for (const known of ['sendPrompt', 'listSessions', 'previewStart', 'getSettings']) {
    assert.ok(real.has(known), `parser missed a known member: ${known}`)
  }
})

test('the fake bridge exposes everything the real preload does', () => {
  const real = realBridgeMembers()
  const fake = fakeBridgeMembers()

  const missing = [...real].filter((name) => !fake.has(name)).sort()
  assert.deepEqual(
    missing,
    [],
    `tests/helpers/gronk-api.ts is missing ${missing.length} method(s) the real preload exposes. ` +
      `Renderer tests are validating against a bridge that does not match reality.`
  )
})

test('the fake bridge invents nothing the real preload lacks', () => {
  const real = realBridgeMembers()
  const fake = fakeBridgeMembers()

  // A fake-only method is the mirror failure: a test can exercise a call the
  // shipped app cannot make, and pass.
  const invented = [...fake].filter((name) => !real.has(name)).sort()
  assert.deepEqual(invented, [], 'the fake exposes methods the real preload does not')
})

test('every preview method on the fake is callable, not just present', async () => {
  const bridge = installFakeBridge()
  try {
    const api = (globalThis as Record<string, unknown>).gronk as Record<
      string,
      (...args: unknown[]) => unknown
    >
    // Presence is what drifted undetected; actually invoking is what proves the
    // fake would survive a test that used it.
    const popOut = await api.previewPopOut()
    assert.deepEqual(popOut, { ok: true, message: '' })
    await api.previewDock()
    assert.deepEqual(await api.listSkills(), [])

    const status = (await api.previewStatus()) as Record<string, unknown>
    // usePreview reads poppedOut on mount; undefined here would let a broken
    // detached-state read pass.
    assert.ok('poppedOut' in status, 'previewStatus must report poppedOut')

    for (const name of ['previewPopOut', 'previewDock', 'listSkills']) {
      assert.ok(bridge.calls.includes(name), `${name} should be tracked in calls`)
    }
  } finally {
    bridge.restore()
  }
})
