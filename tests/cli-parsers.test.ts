import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultModels, parseModelsText } from '../electron/main/models'
import {
  extractDeviceHint,
  looksUnauthenticated,
  parseLoginLabel,
  sanitizeCliText
} from '../electron/main/auth'
import { exportTranscriptMarkdown } from '../electron/main/fs-utils'

// ── `grok models` output ────────────────────────────────────────────

test('bullet list output is parsed and the default is marked', () => {
  const models = parseModelsText(`Available models:
  * grok-4.5 (default)
  - grok-build
  • grok-code-fast`)
  assert.deepEqual(models?.map((m) => m.id), ['grok-4.5', 'grok-build', 'grok-code-fast'])
  assert.equal(models?.[0].isDefault, true)
  assert.equal(models?.[1].isDefault, false)
})

test('a "Default model:" line marks the default even without an inline note', () => {
  const models = parseModelsText(`Default model: grok-build
  - grok-4.5
  - grok-build`)
  assert.equal(models?.find((m) => m.id === 'grok-build')?.isDefault, true)
  assert.equal(models?.find((m) => m.id === 'grok-4.5')?.isDefault, false)
})

test('JSON output is accepted as a fallback', () => {
  const models = parseModelsText('{"models":[{"id":"grok-4.5","name":"Grok 4.5"},{"id":"grok-build"}]}')
  assert.deepEqual(models?.map((m) => m.id), ['grok-4.5', 'grok-build'])
  assert.equal(models?.[0].name, 'Grok 4.5')
  assert.equal(models?.[1].name, 'grok-build', 'name falls back to the id')
})

test('a lone "Default model:" line still yields one model', () => {
  assert.deepEqual(parseModelsText('Default model: grok-4.5')?.map((m) => m.id), ['grok-4.5'])
})

test('unparseable output returns null so the caller can fall back', () => {
  assert.equal(parseModelsText(''), null)
  assert.equal(parseModelsText('   \n  '), null)
  assert.equal(parseModelsText('something went wrong'), null)
})

test('the built-in fallback list is non-empty and has exactly one default', () => {
  const fallback = defaultModels()
  assert.ok(fallback.length > 0)
  assert.equal(fallback.filter((m) => m.isDefault).length, 1)
})

// ── Auth label: never surface an email ──────────────────────────────

test('a provider label is surfaced as-is', () => {
  assert.equal(parseLoginLabel('You are logged in with grok.com.'), 'grok.com')
  assert.equal(parseLoginLabel('Logged in as acme corp'), 'acme corp')
})

test('an email address is never surfaced as the account label', () => {
  assert.equal(parseLoginLabel('You are logged in with user@example.com.'), 'Signed in')
  assert.equal(parseLoginLabel('Logged in as first.last@corp.co.uk'), 'Signed in')
})

test('the label is length-capped and absent when there is nothing to read', () => {
  assert.equal(parseLoginLabel('nothing useful here'), undefined)
  assert.ok((parseLoginLabel(`Logged in as ${'a'.repeat(200)}`) || '').length <= 64)
})

// ── Unauthenticated detection ───────────────────────────────────────

test('common CLI sign-out phrasings are detected', () => {
  for (const text of [
    'Error: not logged in',
    'Please run grok login',
    'authentication required',
    'HTTP 401 Unauthorized',
    'invalid api key',
    'No credentials found'
  ]) {
    assert.equal(looksUnauthenticated(text, ''), true, text)
    assert.equal(looksUnauthenticated('', text), true, `stderr: ${text}`)
  }
})

test('a normal successful response is not read as signed out', () => {
  assert.equal(looksUnauthenticated('Available models:\n * grok-4.5', ''), false)
  assert.equal(looksUnauthenticated('', ''), false)
})

// ── CLI text surfaced to the UI ─────────────────────────────────────

test('CLI text is redacted and trimmed before it reaches the UI', () => {
  const out = sanitizeCliText('  api_key=SUPERSECRET123 failed  ')
  assert.ok(!out.includes('SUPERSECRET123'))
  assert.equal(out, out.trim())
})

test('device-login hints keep the useful lines and drop the noise', () => {
  const hint = extractDeviceHint(`
Welcome!

Open https://x.ai/device and enter code ABCD-1234
random unrelated banner text
`)
  assert.ok(hint?.includes('https://x.ai/device'))
  assert.ok(!hint?.includes('random unrelated banner'))
})

test('a hint with nothing actionable is undefined', () => {
  assert.equal(extractDeviceHint('\n  \n'), undefined)
  assert.equal(extractDeviceHint('all quiet'), undefined)
})

test('device hints are length-capped', () => {
  const many = Array.from({ length: 60 }, (_, i) => `enter code ${i}`).join('\n')
  assert.ok((extractDeviceHint(many) || '').length <= 800)
})

// ── Transcript export ───────────────────────────────────────────────

test('markdown export labels roles and blockquotes the thinking', () => {
  const md = exportTranscriptMarkdown('My session', [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hi there', thought: 'considering\noptions' },
    { role: 'system', text: '' }
  ])
  assert.ok(md.startsWith('# My session'))
  assert.ok(md.includes('## Operator'))
  assert.ok(md.includes('## Grok'))
  assert.ok(md.includes('## System'))
  assert.ok(md.includes('> considering'))
  assert.ok(md.includes('> options'))
  assert.ok(md.includes('_(empty)_'), 'an empty message is marked, not silently blank')
})

test('the export attributes itself to Grok, once, above the transcript', () => {
  const md = exportTranscriptMarkdown('My session', [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hi there' }
  ])
  // One of the two phrasings xAI's brand guidelines ask for on distributed
  // generated material. Counted rather than merely found: a phrase repeated per
  // message would be noise, and this is the only file the app hands to someone
  // else.
  const hits = md.split('Written with Grok').length - 1
  assert.equal(hits, 1, 'attribution should appear exactly once')
  assert.ok(
    md.indexOf('Written with Grok') < md.indexOf('## Operator'),
    'it has to be above the transcript to be noticeable'
  )
  // The role headings are what stop a shared transcript reading as though Gronk
  // wrote the replies, so they stay.
  assert.ok(md.includes('## Grok'))
})

// ── What a rejected RPC call tells the user ─────────────────────────────────

test('A GENERIC RPC FAILURE NAMES THE CALL AND GUESSES AT NOTHING', async () => {
  // Real report: the banner said "Internal error" and nothing else. This first shipped
  // suggesting a spent plan quota, which was wrong — the CLI reports rate limits on
  // -32003 with its own copy and classifies -32603 as a server error specifically not a
  // rate limit (xai-org/grok-build). So the guess sent people to check the one thing the
  // CLI would already have told them about clearly.
  const { rpcErrorMessage } = await import('../electron/main/acp/client')

  const generic = rpcErrorMessage('session/prompt', { code: -32603, message: 'Internal error' })
  assert.match(generic, /session\/prompt/, 'the failed call is not named')
  assert.match(generic, /-32603/)
  assert.doesNotMatch(generic, /usage limits|quota/i, 'it is guessing at a cause again')
  assert.match(generic, /inside the agent/i, 'it does not say whose fault this is')

  // A real message from the agent is kept as-is: it knows more than this function does.
  const said = rpcErrorMessage('session/load', { code: -32602, message: 'unknown session id' })
  assert.match(said, /unknown session id/)
  assert.doesNotMatch(said, /inside the agent/i, 'a real reason was buried under boilerplate')

  // Detail from the agent beats both.
  const detailed = rpcErrorMessage('session/prompt', {
    code: -32603,
    message: 'Internal error',
    data: 'model overloaded'
  })
  assert.match(detailed, /model overloaded/)
})

/**
 * The one refusal that is not a fault.
 *
 * A real 429 arrived in the field as: "The agent failed on session/prompt (-32003): Rate
 * limited". That describes a broken app to someone whose account had simply run out,
 * names a protocol method they have no reason to know exists, and — worse — the reply
 * carried the limit, the amount used and the reset window, none of which reached the
 * screen. The person had to be told by hand what their own app already knew.
 */
test('A USAGE LIMIT IS REPORTED AS ONE, NOT AS A CRASH', async () => {
  const { rpcErrorMessage } = await import('../electron/main/acp/client')

  const real =
    "API error (status 429 Too Many Requests): subscription:free-usage-exhausted: You've " +
    'used all the included free usage for model grok-4.6 for now. Usage resets over a ' +
    'rolling 24-hour window — tokens (actual/limit): 623806/500000.'

  const out = rpcErrorMessage('session/prompt', { code: -32003, message: 'Rate limited', data: real })

  assert.match(out, /usage limit/i, 'it does not say what happened')
  assert.match(out, /623806\/500000/, 'the numbers that say when work resumes were dropped')
  assert.match(out, /rolling 24-hour window/, 'the reset window was dropped')
  // The framing that made this read as a bug in the app.
  assert.doesNotMatch(out, /failed/i, 'a spent allowance is still described as a failure')
  assert.doesNotMatch(out, /session\/prompt/, 'it names a protocol method at the user')
})

test('THE AGENT SAYS WHICH LIMIT — THIS DOES NOT GUESS', async () => {
  const { rpcErrorMessage } = await import('../electron/main/acp/client')

  // Nothing attached. The sentence must still be true, which means saying nothing about
  // which limit, how long, or when. Guessing at a cause here is the exact mistake that
  // shipped once already on -32603.
  const bare = rpcErrorMessage('session/prompt', { code: -32003, message: 'Rate limited' })
  assert.match(bare, /usage limit/i)
  assert.doesNotMatch(bare, /week|day|hour|minute|reset|free|subscription|upgrade/i)
})

test('DETAIL IS READ WHETHER IT ARRIVES AS TEXT OR AS A FIELD', async () => {
  const { rpcErrorMessage, errorDetailText } = await import('../electron/main/acp/client')

  // The old check accepted strings only, so an object shape dropped the whole detail.
  assert.equal(errorDetailText({ message: 'the useful part' }), 'the useful part')
  assert.equal(errorDetailText({ detail: 'the useful part' }), 'the useful part')
  assert.equal(errorDetailText('the useful part'), 'the useful part')
  // No dump of the whole object: unreadable in a banner, and carries every field the
  // agent felt like attaching.
  assert.equal(errorDetailText({ retryAfter: 60 }), '')
  assert.equal(errorDetailText(null), '')

  const structured = rpcErrorMessage('session/prompt', {
    code: -32602,
    message: 'Invalid params',
    data: { message: 'missing field `modelId`' }
  })
  assert.match(structured, /missing field/, 'a structured detail never reached the screen')
})

test('AN ERROR DETAIL IS REDACTED BEFORE IT IS SHOWN', async () => {
  const { rpcErrorMessage } = await import('../electron/main/acp/client')

  // An error detail is exactly where an echoed auth header ends up, and this text goes
  // on screen, into screenshots, and into bug reports.
  const leaky = rpcErrorMessage('session/prompt', {
    code: -32003,
    message: 'Rate limited',
    data: 'rejected: Authorization: Bearer xai-abcdef0123456789'
  })
  assert.doesNotMatch(leaky, /xai-abcdef/, 'a token reached the error banner')
})
