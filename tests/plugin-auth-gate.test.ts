import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Every plugin or MCP handler that runs third-party code checks the user is
 * signed in first.
 *
 * The rule was followed by six handlers and enforced by nothing: no test
 * mentioned `assertAuthenticated`, so all six gates could be removed with the
 * suite green. That is the same gap `ipc-handler-guard` was written to close for
 * the sender check, and this is the same shape of answer.
 *
 * Checked per handler rather than by counting gates, because six handlers and
 * six gates also describes a file where one has two and another has none.
 *
 * What this can and cannot do. It reads source, so it proves a call is written
 * in the handler body, not that it runs before the CLI on every path through it;
 * ordering is checked crudely, by position. It cannot see a handler registered
 * somewhere other than this file. It is a floor, not a proof.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_IPC = path.join(ROOT, 'electron/main/ipc/plugins.ts')

/**
 * Channels whose handler executes code that did not come from this app, or
 * writes the CLI's configuration.
 *
 * `mcp-doctor` belongs here despite writing nothing: it dials the configured
 * servers and starts the stdio ones, which is running someone else's program.
 * Listed by hand so that adding a handler is a decision rather than a default,
 * and the completeness of the list is checked below.
 */
const MUST_BE_GATED = [
  'gronk:plugin-install',
  'gronk:plugin-enable',
  'gronk:plugin-disable',
  'gronk:plugin-uninstall',
  'gronk:mcp-add',
  'gronk:mcp-remove',
  'gronk:mcp-doctor'
]

/** Handlers that only read, and are gated by the sender check alone. */
const READ_ONLY = [
  'gronk:plugin-list',
  'gronk:plugin-available',
  'gronk:plugin-marketplaces',
  'gronk:mcp-list',
  'gronk:list-skills'
]

interface Handler {
  channel: string
  body: string
}

function handlers(): Handler[] {
  const source = fs.readFileSync(PLUGINS_IPC, 'utf8')
  const parts = source.split('ipcMain.handle(')
  const out: Handler[] = []
  for (let i = 1; i < parts.length; i++) {
    const body = parts[i]
    const channel = body.match(/^\s*['"`]([^'"`]+)['"`]/)?.[1]
    if (channel) out.push({ channel, body })
  }
  return out
}

test('the scan finds the handlers it is supposed to be checking', () => {
  // Vacuity guard. If registration changes shape so the marker stops matching,
  // every test below would pass over an empty list and report the file as
  // perfectly gated.
  const found = handlers().map((h) => h.channel)
  for (const channel of [...MUST_BE_GATED, ...READ_ONLY]) {
    assert.ok(found.includes(channel), `${channel} was not found by the scan`)
  }
})

test('EVERY HANDLER THAT RUNS THIRD-PARTY CODE CHECKS THE SIGN-IN FIRST', () => {
  const offenders = handlers()
    .filter((h) => MUST_BE_GATED.includes(h.channel))
    .filter((h) => !h.body.includes('assertAuthenticated('))
    .map((h) => h.channel)

  assert.deepEqual(offenders, [], 'these run someone else\'s code without checking the sign-in')
})

test('the check runs before the CLI is invoked, not after', () => {
  // Both halves of the ordering matter. Arguments are validated first so a
  // malformed request never reaches the probe, which spawns the CLI itself; the
  // probe comes before the call so a refused user never reaches it.
  // The call is located wherever it appears, not only after a `return`. Bound to
  // the keyword it would miss a handler that assigns the result first and
  // returns it below the gate, which is the same defect wearing a different
  // statement.
  const INVOKES_CLI =
    /\b(installPlugin|enablePlugin|disablePlugin|uninstallPlugin|addMcpServer|removeMcpServer|mcpDoctor)\(/

  const late: string[] = []
  const ungrounded: string[] = []
  for (const h of handlers()) {
    if (!MUST_BE_GATED.includes(h.channel)) continue
    const gate = h.body.indexOf('assertAuthenticated(')
    const call = h.body.search(INVOKES_CLI)
    // A gated handler that calls none of the known entry points is not proof of
    // anything; it means this list has gone stale and the ordering above is
    // being checked against nothing.
    if (call < 0) ungrounded.push(h.channel)
    else if (gate >= 0 && gate > call) late.push(h.channel)
  }
  assert.deepEqual(late, [], 'the sign-in is checked after the work has already started')
  assert.deepEqual(ungrounded, [], 'update INVOKES_CLI: these handlers call something it does not know')
})

test('a read-only handler is not gated, so the list means something', () => {
  // Without this the rule could be satisfied by gating everything, which would
  // spawn the CLI and hit the network to answer a question about local state.
  const overGated = handlers()
    .filter((h) => READ_ONLY.includes(h.channel))
    .filter((h) => h.body.includes('assertAuthenticated('))
    .map((h) => h.channel)

  assert.deepEqual(overGated, [])
})

test('a handler that is neither listed is a decision somebody has to make', () => {
  // The list is by hand, so this is what stops a new handler being added to the
  // file and quietly belonging to neither category.
  const known = new Set([...MUST_BE_GATED, ...READ_ONLY])
  const unclassified = handlers()
    .map((h) => h.channel)
    .filter((c) => !known.has(c))

  assert.deepEqual(
    unclassified,
    [],
    'add it to MUST_BE_GATED or READ_ONLY, whichever is true, rather than deleting this test'
  )
})
