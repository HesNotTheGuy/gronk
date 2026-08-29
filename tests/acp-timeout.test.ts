import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * A pending JSON-RPC entry is cleared by a reply or by the child exiting, and by
 * nothing else. So an agent that stays alive and stops answering left every
 * awaiting caller unsettled forever: a hung `initialize` meant a loading skeleton
 * with no error and no way out but a restart.
 *
 * Read from source. Driving the real client needs a child process, and the suite
 * has none — the same reason `agent-manager` is pinned this way. What matters here
 * is a handful of properties that are easy to lose in an edit.
 */

const SRC = readFileSync(
  fileURLToPath(new URL('../electron/main/acp/client.ts', import.meta.url)),
  'utf8'
)

test('CONTROL-PLANE CALLS ARE BOUNDED BY DEFAULT', () => {
  assert.match(SRC, /const DEFAULT_REQUEST_TIMEOUT_MS = 60_000/)
  // The default is on the parameter, so a new call site inherits it by writing
  // nothing. Opting out has to be deliberate and visible.
  assert.match(SRC, /timeoutMs: number \| null = DEFAULT_REQUEST_TIMEOUT_MS/)
})

test('A PROMPT IS THE ONE CALL WITH NO CLOCK', () => {
  // A turn runs as long as the work takes. A timeout here would kill real work
  // mid-answer, which is worse than the hang it would prevent.
  assert.match(SRC, /const PROMPT_UNBOUNDED = null/)
  assert.match(SRC, /'session\/prompt',\s*\{ sessionId, prompt \},\s*PROMPT_UNBOUNDED/)

  // And it must be the ONLY call that opts out. Counting ARGUMENT uses, not
  // mentions: the constant is referred to in comments, and a guard that a comment
  // can break gets deleted rather than heeded.
  const optOuts = SRC.match(/,\s*PROMPT_UNBOUNDED\s*\)/g) ?? []
  assert.equal(
    optOuts.length,
    1,
    `${optOuts.length} calls opt out of the timeout — every one of them can hang forever`
  )
})

test('A TIMED-OUT CALL NAMES ITSELF AND CLEARS ITS PENDING ENTRY', () => {
  // The message has to say which call gave up: "the agent stopped answering" with
  // no method is the same dead end as the bare "Internal error" this file already
  // has history with.
  assert.match(SRC, /did not answer \$\{method\}/)
  // Settling deletes from `pending` before resolving or rejecting, so a late reply
  // for a call already given up on cannot settle it twice.
  assert.match(SRC, /this\.pending\.delete\(id\)/)
})

test('THE TIMER CANNOT HOLD THE PROCESS OPEN', () => {
  // A pending timer keeps Node alive; on quit that is an app that will not exit.
  assert.match(SRC, /timer\.unref\?\.\(\)/)
})

test('A FAILED WRITE REJECTS INSTEAD OF LEAVING A PENDING ENTRY', () => {
  // `write` throws when stdin is gone. Before, that threw out of `request` with the
  // entry already registered — so the caller saw a synchronous throw AND the entry
  // stayed until the child exited.
  assert.match(SRC, /try \{\s*this\.write\(\{ jsonrpc: '2\.0', id, method, params \}\)/)
})
