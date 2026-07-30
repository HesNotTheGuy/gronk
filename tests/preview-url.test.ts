import test from 'node:test'
import assert from 'node:assert/strict'
import { extractDevServerUrl } from '../electron/main/preview'
import { redactSecrets } from '../electron/main/redact'

/**
 * Finding the dev server's URL in its own output.
 *
 * Two shipped defects lived here. The capture regex stopped only at whitespace
 * and quotes, so any banner that put punctuation next to the URL produced a
 * string `new URL()` rejects — and the pane then waited forever with no error.
 * And the scan ran on the REDACTED copy of the output, so a URL carrying a
 * secret-shaped query string was rewritten before it was ever matched.
 */

// Real banner shapes. Each one previously captured its own punctuation.
const PUNCTUATED = [
  ['trailing full stop', 'App running at http://localhost:3000.'],
  ['parenthesised', 'Server ready (http://localhost:3000)'],
  ['angle bracketed', 'Listening on <http://localhost:3000>'],
  ['markdown link', 'Open [http://localhost:3000](http://localhost:3000)'],
  ['comma in a list', 'Ports: http://localhost:3000, http://localhost:3001'],
  ['trailing semicolon', 'ready http://localhost:3000;']
]

for (const [label, line] of PUNCTUATED) {
  test(`a URL is recovered cleanly when ${label}`, () => {
    const url = extractDevServerUrl(line)
    assert.ok(url, `no URL extracted from: ${line}`)
    // The decisive assertion: whatever comes back must actually parse, because
    // the caller hands it straight to loadURL.
    assert.doesNotThrow(() => new URL(url), `unparseable: ${url}`)
    assert.equal(new URL(url).port, '3000')
    assert.ok(!/[.,;:!?`)\]}>]$/.test(url), `kept trailing punctuation: ${url}`)
  })
}

test('the plain Vite banner still works', () => {
  const url = extractDevServerUrl('  ➜  Local:   http://localhost:5173/')
  assert.equal(url, 'http://localhost:5173/')
})

test('127.0.0.1 and [::1] are recognised as well as localhost', () => {
  assert.equal(extractDevServerUrl('on http://127.0.0.1:8080/'), 'http://127.0.0.1:8080/')
  assert.ok(extractDevServerUrl('on http://[::1]:8080/'))
})

// The bug in full: the URL was matched against redactSecrets(chunk), so the
// server's own address came back mangled and the pane loaded a broken URL.
test('a URL carrying a secret-shaped query survives, because the raw text is scanned', () => {
  const line = 'Local: http://localhost:5173/?api_key=abcdefghijklmnop1234567890'
  const redacted = redactSecrets(line)
  assert.notEqual(redacted, line, 'precondition: redaction must alter this line')

  const fromRaw = extractDevServerUrl(line)
  assert.ok(fromRaw)
  assert.doesNotThrow(() => new URL(fromRaw))
  assert.equal(new URL(fromRaw).port, '5173')
})

test('a non-local address in the output is never returned', () => {
  assert.equal(extractDevServerUrl('Network: http://192.168.1.20:5173/'), null)
  assert.equal(extractDevServerUrl('docs at https://example.com/'), null)
})

// The guard is shared with navigation, so a capture that survives the regex but
// fails the localhost test is dropped rather than loaded.
test('a lookalike host is rejected even though the regex-ish shape matches', () => {
  assert.equal(extractDevServerUrl('http://localhost.evil.example:3000/'), null)
})

test('output with no URL at all yields null rather than a partial match', () => {
  assert.equal(extractDevServerUrl('listening on port 3000'), null)
  assert.equal(extractDevServerUrl(''), null)
})
