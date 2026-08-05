import test from 'node:test'
import assert from 'node:assert/strict'
import { redactPreview, redactSecrets, redactValue } from '../electron/main/redact'

/** No test may assert a redacted output that still contains the raw secret. */
function assertGone(output: string, secret: string): void {
  assert.ok(!output.includes(secret), `secret leaked in: ${output}`)
}

test('redacts provider API keys', () => {
  const out = redactSecrets('key is xai-abcdefgh1234567890 ok')
  assertGone(out, 'xai-abcdefgh1234567890')
  assert.equal(out, 'key is [redacted] ok')
})

test('redacts JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'
  assert.equal(redactSecrets(jwt), '[redacted-jwt]')
})

test('redacts key=value secrets', () => {
  const out = redactSecrets('api_key=SUPERSECRET123 rest')
  assertGone(out, 'SUPERSECRET123')
  assert.equal(out, 'api_key=[redacted] rest')
})

// Regression: the auth-scheme word used to satisfy the value matcher, so the
// token after `Bearer` survived. See AUTH_SCHEME in redact.ts.
test('Authorization header does not leak the token after the scheme word', () => {
  for (const scheme of ['Bearer', 'Basic', 'Token', 'Digest']) {
    const out = redactSecrets(`Authorization: ${scheme} abcdefghijklmnop123`)
    assertGone(out, 'abcdefghijklmnop123')
  }
})

test('bare Bearer token is redacted', () => {
  const out = redactSecrets('curl -H "Bearer abcdefghijklmnop123"')
  assertGone(out, 'abcdefghijklmnop123')
})

test('redacts email addresses', () => {
  assert.equal(redactSecrets('mail me at user@example.com please'), 'mail me at [redacted-email] please')
})

// Over-eager redaction corrupted transcripts on reload.
test('ordinary prose and paths survive untouched', () => {
  const prose = 'The quick brown fox. Version 1.2.3 at C:/Users/x/file.ts task-runner'
  assert.equal(redactSecrets(prose), prose)
})

test('empty input is returned as-is', () => {
  assert.equal(redactSecrets(''), '')
})

test('redactValue drops secret-named keys at any depth', () => {
  const out = redactValue({
    apiKey: 'a',
    api_key: 'b',
    normal: 'ok',
    env: { API_KEY: 'c' }
  }) as Record<string, unknown>
  assert.equal(out.apiKey, '[redacted]')
  assert.equal(out.api_key, '[redacted]')
  assert.equal(out.normal, 'ok')
  assert.deepEqual(out.env, { API_KEY: '[redacted]' })
})

test('redactValue truncates oversized strings and deep nesting', () => {
  const long = redactValue('x'.repeat(5000)) as string
  assert.ok(long.length < 5000)
  assert.ok(long.endsWith('…[truncated]'))

  let deep: unknown = 'leaf'
  for (let i = 0; i < 12; i++) deep = { next: deep }
  assert.ok(JSON.stringify(redactValue(deep)).includes('[truncated-depth]'))
})

test('redactValue caps array length', () => {
  const out = redactValue(Array.from({ length: 250 }, (_, i) => i)) as unknown[]
  assert.equal(out.length, 100)
})

test('redactPreview redacts and truncates', () => {
  assert.equal(redactPreview(undefined), undefined)
  const out = redactPreview({ token: 'xai-abcdefgh1234567890' }) as string
  assertGone(out, 'xai-abcdefgh1234567890')
  assert.ok((redactPreview('y'.repeat(900), 100) as string).length <= 100)
})
