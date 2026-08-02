import test from 'node:test'
import assert from 'node:assert/strict'
import { extractDevServerUrl } from '../electron/main/preview'
import { isLocalPreviewUrl } from '../electron/main/ipc-guard'
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
  assert.equal(extractDevServerUrl('on http://[::1]:8080/'), 'http://[::1]:8080/')
})

/**
 * A wildcard bind address is an announcement, not a destination.
 *
 * Measured: `python -m http.server 8765` prints `http://[::]:8765/` and was not
 * detected, so the pane stayed blank for a server that was listening; the same
 * server with `--bind 127.0.0.1` prints a loopback address and worked. "All
 * interfaces" includes loopback, so the fix is to rewrite the host rather than
 * to teach the navigation guard a non-loopback address.
 */
const WILDCARD_BANNERS = [
  ['the IPv6 any-address', 'Serving HTTP on :: port 8765 (http://[::]:8765/) ...'],
  ['the IPv4 any-address', 'Serving HTTP on 0.0.0.0 port 8765 (http://0.0.0.0:8765/) ...']
]

for (const [label, line] of WILDCARD_BANNERS) {
  test(`${label} is rewritten to localhost`, () => {
    const url = extractDevServerUrl(line)
    assert.equal(url, 'http://localhost:8765/')
    // The rewritten form is what actually gets loaded, so it must clear the
    // unchanged guard rather than be exempted from it.
    assert.ok(isLocalPreviewUrl(url!))
  })
}

// The guard must NOT have been widened to cover what the scanner now accepts.
// If it ever is, the pane can navigate to a non-loopback address.
test('the navigation guard still refuses a wildcard host outright', () => {
  assert.equal(isLocalPreviewUrl('http://[::]:8765/'), false)
  assert.equal(isLocalPreviewUrl('http://0.0.0.0:8765/'), false)
})

test('rewriting a wildcard host leaves the rest of the URL alone', () => {
  assert.equal(
    extractDevServerUrl('Local: https://0.0.0.0:5173/app?token=abc&x=1#frag'),
    'https://localhost:5173/app?token=abc&x=1#frag'
  )
  assert.equal(
    extractDevServerUrl('Local: http://[::]:5173/nested/path?q=%20'),
    'http://localhost:5173/nested/path?q=%20'
  )
})

test('a wildcard banner still has its trailing punctuation trimmed', () => {
  assert.equal(extractDevServerUrl('Running at http://[::]:8765/.'), 'http://localhost:8765/')
  assert.equal(extractDevServerUrl('Running at http://0.0.0.0:8765/;'), 'http://localhost:8765/')
})

// The rewrite is anchored, so a wildcard-looking substring elsewhere in the URL
// is left exactly where it is.
test('only a leading wildcard host is rewritten', () => {
  assert.equal(
    extractDevServerUrl('Local: http://localhost:3000/#0.0.0.0:1'),
    'http://localhost:3000/#0.0.0.0:1'
  )
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
  // Same port and shape as the wildcard banners above, to show that widening
  // the scanner for those did not open the door for an arbitrary host.
  assert.equal(extractDevServerUrl('Serving on http://evil.example:8765/'), null)
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
