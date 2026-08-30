import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decideAuth,
  hasCredentialEvidence,
  looksLikeNetworkFailure,
  shouldRefreshOnFocus,
  type ProbeFacts
} from '../electron/main/auth-decision'
import { authMessage } from '../electron/main/auth'

/**
 * The sign-in decision table.
 *
 * Diagnosed from a mac tester's screenshot with all three states in one frame:
 * the sidebar saying SIGNED IN, the composer knowing otherwise, and
 * `gronk:start-agent` failing with the CLI's own "Authentication required".
 * That string is in no file in this repo, so the CLI emitted it during agent
 * boot, which means `assertAuthenticated` had already let the start through,
 * which means the probe had returned authenticated on a machine that was not.
 *
 * The cause was one line: a successful `grok models` was treated as proof of
 * credentials. Listing models does not need an account, so a never-signed-in
 * machine read as signed in and sign-out flipped straight back.
 *
 * This is exactly the kind of table that regresses silently, which is why the
 * whole of it is pinned here rather than only the case that broke.
 */

/** A machine with a working CLI, a model list, and nothing else. The tester's. */
function facts(over: Partial<ProbeFacts> = {}): ProbeFacts {
  return {
    code: 0,
    label: undefined,
    modelsListed: true,
    saysUnauthenticated: false,
    filePresent: false,
    envKey: false,
    ...over
  }
}

test('THE BUG: models listing on a never-signed-in machine is not signed in', () => {
  // `grok models` exits 0 and prints a list without an account. Before this, the
  // sidebar said SIGNED IN here and agent boot got as far as the CLI's own auth
  // error.
  const d = decideAuth(facts())
  assert.equal(d.authenticated, false)
  assert.equal(d.state, 'unauthenticated')
  assert.equal(d.method, 'none')
  assert.match(d.message ?? '', /does not need one|no session/i)
})

test('a model list alone is never evidence, whatever the CLI printed', () => {
  // The necessary-but-not-sufficient rule, stated directly. Only the three
  // positive signals below can carry a machine into authenticated.
  assert.equal(hasCredentialEvidence(facts()), false)
  assert.equal(hasCredentialEvidence(facts({ label: 'grok.com' })), true)
  assert.equal(hasCredentialEvidence(facts({ filePresent: true })), true)
  assert.equal(hasCredentialEvidence(facts({ envKey: true })), true)
})

test('a label the CLI printed is a session', () => {
  const d = decideAuth(facts({ label: 'grok.com' }))
  assert.equal(d.authenticated, true)
  assert.equal(d.method, 'session')
  assert.equal(d.accountLabel, 'grok.com')
  assert.equal(d.message, 'Signed in via grok.com')
})

test('cached credentials with no label are still a session', () => {
  // Signing in writes the file. A CLI that prints no login line still left it.
  const d = decideAuth(facts({ filePresent: true }))
  assert.equal(d.authenticated, true)
  assert.equal(d.method, 'session')
  assert.equal(d.hasAuthFile, true)
})

test('an environment key with no file is named as an environment key', () => {
  const d = decideAuth(facts({ envKey: true }))
  assert.equal(d.authenticated, true)
  assert.equal(d.method, 'api_key_env')
  assert.equal(d.accountLabel, 'API key (environment)')
  assert.match(d.message ?? '', /XAI_API_KEY/)
  assert.match(d.message ?? '', /not by a signed-in session/i)
})

test('SIGN OUT: clearing the session leaves nothing behind, so the button works', () => {
  // The other half of the report. `grok logout` succeeds and deletes the file,
  // the re-probe runs `grok models`, and it still exits 0. Before this the state
  // came straight back as signed in and the button looked dead.
  const afterLogout = decideAuth(facts({ label: undefined, filePresent: false, envKey: false }))
  assert.equal(afterLogout.authenticated, false)
  assert.equal(afterLogout.state, 'unauthenticated')
})

test('SIGN OUT with an env key still set says so rather than flipping back', () => {
  // Signing out cannot unset an environment variable. The machine really is
  // still authenticated, and the honest answer names the thing answering.
  const d = decideAuth(facts({ envKey: true }))
  assert.equal(d.authenticated, true)
  assert.equal(d.method, 'api_key_env')
  assert.notEqual(d.accountLabel, 'Signed in', 'must not read as a browser session')
})

test('the honest middle states are kept, not collapsed', () => {
  // An env key the CLI rejected keeps its own message.
  const rejected = decideAuth(
    facts({ code: 1, modelsListed: false, saysUnauthenticated: true, envKey: true })
  )
  assert.equal(rejected.authenticated, false)
  assert.equal(rejected.method, 'api_key_env')
  assert.match(rejected.message ?? '', /rejected it/i)

  // A stale file keeps its own message.
  const stale = decideAuth(
    facts({ code: 1, modelsListed: false, saysUnauthenticated: true, filePresent: true })
  )
  assert.equal(stale.authenticated, false)
  assert.match(stale.message ?? '', /invalid or expired/i)

  // Neither is the same as never having signed in.
  const never = decideAuth(facts({ code: 1, modelsListed: false, saysUnauthenticated: true }))
  assert.match(never.message ?? '', /Not signed in/i)
})

test('a non-zero exit is never authenticated, whatever is on disk', () => {
  for (const over of [{ filePresent: true }, { envKey: true }, { label: 'grok.com' }]) {
    const d = decideAuth(facts({ code: 1, modelsListed: false, ...over }))
    assert.equal(d.authenticated, false, `code 1 with ${JSON.stringify(over)} read as signed in`)
  }
})

test('a killed probe is unknown, not signed out', () => {
  // runGrok resolves with a null code when it kills the child at the timeout.
  // A network stall must not read as a deliberate sign-out.
  const d = decideAuth(facts({ code: null, modelsListed: false, filePresent: true }))
  assert.equal(d.state, 'unauthenticated')
  assert.equal(d.authenticated, false)
  assert.match(d.message ?? '', /invalid or expired/i)
})

test('output that is neither a list nor a refusal is unknown', () => {
  const d = decideAuth(facts({ code: 0, modelsListed: false }))
  assert.equal(d.state, 'unknown')
  assert.equal(d.authenticated, false)
})

test('the file flag is existence only, and stays a boolean', () => {
  // The security rule this probe exists under: ~/.grok/auth.json holds a live
  // token and is never read, parsed or forwarded. The decision may only ever
  // learn that it exists.
  const d = decideAuth(facts({ filePresent: true }))
  assert.equal(typeof d.hasAuthFile, 'boolean')
  assert.equal(typeof d.hasEnvApiKey, 'boolean')
  for (const value of Object.values(d)) {
    assert.notEqual(typeof value, 'object', 'no structured field about the auth file')
  }
})

test('no decision ever carries a token-shaped or email-shaped string', () => {
  // Every message is a literal in this module, so this is a guard against a
  // future one being built from CLI output.
  const cases = [
    facts(),
    facts({ label: 'grok.com' }),
    facts({ envKey: true }),
    facts({ filePresent: true }),
    facts({ code: 1, modelsListed: false, saysUnauthenticated: true })
  ]
  for (const f of cases) {
    const text = JSON.stringify(decideAuth(f))
    assert.ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), 'email-shaped string')
    assert.ok(!/xai-[A-Za-z0-9]{8,}|sk-[A-Za-z0-9]{8,}/.test(text), 'key-shaped string')
  }
})

test('focus refresh is throttled, and the first focus always runs', () => {
  // Focus fires on every alt-tab and the probe spawns the CLI and hits the
  // network, so an unthrottled refresh turns window switching into traffic.
  assert.equal(shouldRefreshOnFocus(null, 1_000, 5_000), true, 'the first focus must probe')
  assert.equal(shouldRefreshOnFocus(1_000, 2_000, 5_000), false, 'too soon')
  assert.equal(shouldRefreshOnFocus(1_000, 5_999, 5_000), false)
  assert.equal(shouldRefreshOnFocus(1_000, 6_000, 5_000), true, 'the interval is inclusive')
  assert.equal(shouldRefreshOnFocus(1_000, 60_000, 5_000), true)
})

// ── A machine that cannot reach xAI still has its credentials ──────────

const FACTS = {
  code: 0,
  label: undefined,
  modelsListed: true,
  saysUnauthenticated: false,
  filePresent: false,
  envKey: false
}

test('A NETWORK FAILURE IS NOT REPORTED AS A MISSING ACCOUNT', () => {
  // The reported case, reconstructed: away from the machine, sent a prompt, got the
  // full-screen sign-in — the CLI's output carrying a timed-out request to auth.x.ai,
  // and the existence check landing while the CLI was rewriting auth.json, so it saw
  // no file. Every fact absent, and the honest answer is "could not check", not
  // "you have no account".
  const offline = decideAuth({ ...FACTS, networkError: true })

  assert.equal(offline.state, 'unknown', 'a transport failure was read as a verdict on the account')
  assert.match(offline.message ?? '', /could not reach/i)
  // The exact sentence that was wrong on screen.
  assert.doesNotMatch(offline.message ?? '', /nothing on this machine shows an account/i)
  assert.doesNotMatch(offline.message ?? '', /^not signed in/i)
})

test('A NETWORK BLIP DOES NOT DISTURB A MACHINE THAT IS CLEARLY SIGNED IN', () => {
  // Credentials on disk and a CLI that answered: that is signed in, and unrelated
  // transport noise in the same output must not downgrade it to "could not check".
  const fine = decideAuth({ ...FACTS, filePresent: true, networkError: true })
  assert.equal(fine.authenticated, true)
  assert.equal(fine.hasAuthFile, true)
})

test('THE CLI SAYING SO STILL BEATS A NETWORK ERROR', () => {
  // A real sign-out must not be softened by a transport message in the same output.
  // With nothing on disk and the CLI saying it plainly, the answer is signed out.
  const out = decideAuth({
    ...FACTS,
    code: 1,
    modelsListed: false,
    saysUnauthenticated: true,
    networkError: true
  })
  assert.equal(out.authenticated, false)
  assert.notEqual(out.state, 'unknown', 'an explicit sign-out was softened into "unknown"')
})

test('THE NO-ACCOUNT BRANCH REPORTS THE FACTS IT WAS GIVEN', () => {
  // It used to hardcode `hasAuthFile: false`. Only reachable when all three are
  // absent, so the constants were true — and a constant that restates a fact is
  // one edit away from lying.
  const none = decideAuth({ ...FACTS })
  assert.equal(none.hasAuthFile, false)
  assert.equal(none.hasEnvApiKey, false)
  assert.match(none.message ?? '', /nothing on this machine shows an account/i)
})

test('A TRANSPORT FAILURE IS RECOGNISED FROM WHAT THE CLI ACTUALLY PRINTS', () => {
  // The exact string from the report, plus the other shapes a transport failure
  // takes. Narrow on purpose: matching too eagerly would mask a real sign-out.
  const real =
    'Error: error sending request for url (https://auth.x.ai/.well-known/openid-configuration): operation timed out'
  assert.equal(looksLikeNetworkFailure(real), true)
  assert.equal(looksLikeNetworkFailure('connection refused'), true)
  assert.equal(looksLikeNetworkFailure('failed to lookup address information'), true)
  assert.equal(looksLikeNetworkFailure('You are not authenticated.'), false)
  assert.equal(looksLikeNetworkFailure('Available models:\n  * grok-4.6'), false)
})

/**
 * The offline message has to survive the trip to the screen.
 *
 * `decideAuth` answering well is only half of it: `observeAuth` then replaced the
 * message for EVERY `unknown` result with the CLI's own output, and on this path
 * that output is exactly the `operation timed out` line the change exists to stop
 * showing. The fallback could never fire, because the branch is only reached when
 * that text is present. So the sentence written for the user was dead code, and
 * the pure-function test above passed while the app showed something else.
 */

const TIMED_OUT =
  'Error: error sending request for url (https://auth.x.ai/.well-known/openid-configuration): operation timed out'

test('THE OFFLINE MESSAGE IS WHAT THE USER READS, NOT THE CLI OUTPUT', () => {
  const decision = decideAuth({
    code: 1,
    label: null,
    modelsListed: false,
    saysUnauthenticated: false,
    filePresent: true,
    envKey: false,
    networkError: true
  })
  assert.equal(decision.state, 'unknown')
  const shown = authMessage(decision, TIMED_OUT, true)
  assert.match(shown ?? '', /could not reach/i)
  assert.doesNotMatch(shown ?? '', /operation timed out/i)
  assert.doesNotMatch(shown ?? '', /https?:\/\//, 'a URL from a subprocess reached the screen')
})

test('THE CLI STILL SPEAKS WHERE NOTHING BETTER IS KNOWN', () => {
  // The other `unknown` producer: genuinely undiagnosed. Its own words are the
  // best available, which is why the override exists at all.
  const decision = decideAuth({
    code: 0,
    label: null,
    modelsListed: false,
    saysUnauthenticated: false,
    filePresent: false,
    envKey: false,
    networkError: false
  })
  assert.equal(decision.state, 'unknown')
  assert.match(authMessage(decision, 'grok: something nobody has seen before', false) ?? '', /nobody has seen/)
})

test('A KNOWN STATE IS NEVER OVERWRITTEN BY SUBPROCESS OUTPUT', () => {
  const decision = decideAuth({
    code: 0,
    label: 'Signed in',
    modelsListed: true,
    saysUnauthenticated: false,
    filePresent: true,
    envKey: false,
    networkError: false
  })
  assert.equal(decision.state, 'authenticated')
  assert.equal(authMessage(decision, 'noise from the CLI', false), decision.message)
})
