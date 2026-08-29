import test from 'node:test'
import assert from 'node:assert/strict'
import { describeCrash, installCrashGuard, makeCrashReporter } from '../electron/main/crash-guard'

/**
 * An unhandled rejection is fatal in the main process, and the main process owns
 * every running `grok agent stdio` child — so one missed `.catch()` ends the app
 * and takes live agents with it, mid-turn, with no window left to explain.
 */

test('WHATEVER WAS THROWN BECOMES ONE REPORTABLE LINE', () => {
  // Anything can be thrown, and a crash reporter that throws while describing a
  // crash is worse than the crash.
  assert.match(describeCrash('uncaughtException', new Error('boom')).message, /boom/)
  assert.match(describeCrash('unhandledRejection', 'a bare string').message, /a bare string/)
  assert.equal(describeCrash('unhandledRejection', undefined).message, 'undefined')
  assert.match(describeCrash('unhandledRejection', { code: 402 }).message, /402/)

  const hostile = {
    get message() {
      throw new Error('nested')
    }
  }
  assert.doesNotThrow(() => describeCrash('uncaughtException', hostile))
})

test('A CRASH MESSAGE IS REDACTED AND BOUNDED', () => {
  // These reach a log and a banner. A rejection from a subprocess call carries
  // the command that failed, and those carry tokens.
  const leaky = new Error('spawn failed: curl -H "Authorization: Bearer xai-abcdef0123456789"')
  const out = describeCrash('unhandledRejection', leaky).message
  assert.doesNotMatch(out, /xai-abcdef/)

  const huge = describeCrash('uncaughtException', new Error('x'.repeat(5000))).message
  assert.ok(huge.length <= 401, `message was ${huge.length} chars`)
  // One line: a stack pasted into a banner destroys the layout.
  assert.doesNotMatch(huge, /\n/)
})

test('THE SAME FAILURE IS REPORTED ONCE, NOT ON EVERY REPEAT', () => {
  // A failing interval would otherwise paint the same banner forever, which is
  // how the diagnostic becomes the bug.
  const seen: string[] = []
  const report = makeCrashReporter((r) => seen.push(r.message))
  report('unhandledRejection', new Error('same'))
  report('unhandledRejection', new Error('same'))
  report('unhandledRejection', new Error('different'))
  assert.deepEqual(seen, ['same', 'different'])
})

test('REPORTING CANNOT ITSELF TAKE THE PROCESS DOWN', () => {
  const report = makeCrashReporter(() => {
    throw new Error('the window went away mid-report')
  })
  assert.doesNotThrow(() => report('uncaughtException', new Error('boom')))
})

/**
 * NOT COVERED HERE, deliberately: that the process actually survives an unhandled
 * rejection. `node --test` installs its own handler for that event and attributes
 * one to the running case, so both a real `Promise.reject` and a `process.emit`
 * fail the test regardless of what the guard does. What is covered is everything
 * the guard decides — describing, redacting, bounding, de-duplicating, and not
 * throwing while reporting — plus that installing and removing it leaves the
 * process listeners exactly as it found them. The surviving half is one
 * `process.on` call, verified by the listener count below.
 */
test('UNINSTALLING LEAVES NO LISTENERS BEHIND', () => {
  const before = process.listenerCount('unhandledRejection')
  const uninstall = installCrashGuard(() => {})
  assert.equal(process.listenerCount('unhandledRejection'), before + 1)
  uninstall()
  assert.equal(process.listenerCount('unhandledRejection'), before)
})
