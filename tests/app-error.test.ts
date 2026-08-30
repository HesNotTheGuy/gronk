import test from 'node:test'
import assert from 'node:assert/strict'
import { raise, resolve, retire, type AppError, type ErrorScope } from '../src/lib/app-error'

/**
 * The rule for when the error banner stops saying what it says.
 *
 * These cover the decision. `use-gronk-error.test.ts` covers the wiring, which
 * is the half that actually broke: the rule being right is no use if a handler
 * never asks it.
 */

const SCOPES: ErrorScope[] = ['agent', 'prompt', 'export']
const err = (scope: ErrorScope): AppError => ({ message: `${scope} failed`, scope })

test('raise tags the message with the scope it is about', () => {
  assert.deepEqual(raise('prompt', 'too long'), { message: 'too long', scope: 'prompt' })
})

test('the newest failure always wins the banner: there is only one line', () => {
  // Not a property of raise so much as of the caller, but pinning it here says
  // the design is deliberate rather than an accident of assignment order.
  const first = raise('agent', 'FIRST')
  const second = raise('export', 'SECOND')
  assert.notEqual(first.message, second.message)
  assert.equal(second.message, 'SECOND')
})

test('nothing showing stays nothing showing', () => {
  for (const scope of SCOPES) {
    assert.equal(retire(null, scope), null)
    assert.equal(resolve(null, scope), null)
  }
})

test('starting an agent supersedes every scope: the conversation is being replaced', () => {
  for (const scope of SCOPES) {
    assert.equal(retire(err(scope), 'agent'), null, `an agent attempt should supersede a ${scope} error`)
  }
})

test('sending a prompt supersedes every scope, because it can only happen once the agent is up', () => {
  for (const scope of SCOPES) {
    assert.equal(retire(err(scope), 'prompt'), null, `a prompt attempt should supersede a ${scope} error`)
  }
})

test('EXPORTING SUPERSEDES ONLY THE LAST EXPORT: it is not evidence the agent is healthy', () => {
  assert.equal(retire(err('export'), 'export'), null)
  // The two that must survive. Writing a transcript to disk says nothing about
  // whether the agent started or whether the last prompt was delivered, so an
  // export must never be able to take those messages down.
  assert.deepEqual(retire(err('agent'), 'export'), err('agent'))
  assert.deepEqual(retire(err('prompt'), 'export'), err('prompt'))
})

test('SUCCESS SPEAKS ONLY FOR ITS OWN SCOPE, which is why resolve is not retire', () => {
  for (const scope of SCOPES) {
    assert.equal(resolve(err(scope), scope), null, `${scope} success should clear a ${scope} error`)
    for (const other of SCOPES.filter((s) => s !== scope)) {
      assert.deepEqual(
        resolve(err(other), scope),
        err(other),
        `${scope} success must not clear a ${other} error`
      )
    }
  }
})

test('the agent coming up clears an agent error and leaves an export failure alone', () => {
  // The concrete case behind the previous test: a connection reaching `ready`
  // is an agent success, and it must not wipe "nothing to export yet".
  assert.equal(resolve(err('agent'), 'agent'), null)
  assert.deepEqual(resolve(err('export'), 'agent'), err('export'))
})

test('retire and resolve differ for agent, and that difference is the point', () => {
  // If these two ever agree for every input, one of them has been collapsed
  // into the other and the rule has quietly become "clear everything".
  const promptError = err('prompt')
  assert.equal(retire(promptError, 'agent'), null, 'starting an agent supersedes a prompt error')
  assert.deepEqual(
    resolve(promptError, 'agent'),
    promptError,
    'an agent merely succeeding does not'
  )
})

test('neither function mutates what it was given', () => {
  const original = err('agent')
  const copy = { ...original }
  retire(original, 'export')
  resolve(original, 'export')
  assert.deepEqual(original, copy)
})

/**
 * `app` carries a failure of the process, not of a turn. It exists because
 * routing one through `agent` told the user their sessions were still running
 * while re-opening the composer underneath a streaming agent.
 */
test('A NEW TURN SUPERSEDES A PROCESS FAILURE THE USER HAS ALREADY SEEN', () => {
  // Otherwise the banner is permanent: nothing in the app begins an `app` attempt,
  // so nothing else would ever clear it.
  assert.equal(retire({ message: 'BOOM', scope: 'app' }, 'agent'), null)
  assert.equal(retire({ message: 'BOOM', scope: 'app' }, 'prompt'), null)
})

test('EXPORTING SOMETHING SAYS NOTHING ABOUT A PROCESS FAILURE', () => {
  const err = { message: 'BOOM', scope: 'app' } as const
  assert.deepEqual(retire(err, 'export'), err)
  assert.deepEqual(resolve(err, 'export'), err)
})

test('A TURN SUCCEEDING DOES NOT PROVE THE PROCESS IS WELL', () => {
  // `resolve` is evidence about its own scope only. A reply arriving does not
  // unmake an unhandled rejection that already happened.
  const err = { message: 'BOOM', scope: 'app' } as const
  assert.deepEqual(resolve(err, 'agent'), err)
})
