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

// ── Auth label: FIX-18, never surface an email ──────────────────────

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
