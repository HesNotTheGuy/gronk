import test from 'node:test'
import assert from 'node:assert/strict'
import {
  costNote,
  detailCostLabel,
  isBilledPerToken,
  summaryCostLabel
} from '../src/lib/cost'
import type { AuthStatus } from '../shared/types'

function auth(method: AuthStatus['method']): AuthStatus {
  return { state: 'authenticated', authenticated: true, method }
}

// The whole point: the CLI reports a cost for every turn no matter how you
// signed in, so the figure alone cannot tell you whether money moved.
test('only an API key spends money per token', () => {
  assert.equal(isBilledPerToken(auth('api_key_env')), true)
  assert.equal(isBilledPerToken(auth('session')), false)
})

test('an unknown or absent credential is not treated as billed', () => {
  // Defaulting the other way would show a spend figure to someone whose billing
  // mode we could not establish — the exact claim this is meant to avoid.
  assert.equal(isBilledPerToken(auth('unknown')), false)
  assert.equal(isBilledPerToken(auth('none')), false)
  assert.equal(isBilledPerToken(null), false)
  assert.equal(isBilledPerToken(undefined), false)
})

test('the glanceable summary shows dollars only when they are real', () => {
  assert.equal(summaryCostLabel(auth('api_key_env')), 'est.')
  assert.equal(summaryCostLabel(auth('session')), null)
  assert.equal(summaryCostLabel(null), null)
})

// The detail panel is opened deliberately, so it always shows the number — the
// label is what distinguishes a charge from an equivalent.
test('the detail label names which of the two figures it is', () => {
  assert.equal(detailCostLabel(auth('api_key_env')), 'Est. cost')
  assert.equal(detailCostLabel(auth('session')), 'At API rates')
})

test('the note never tells a subscriber they were charged', () => {
  const subscription = costNote(auth('session'))
  assert.match(subscription, /nothing is billed per token/i)
  assert.match(subscription, /not as a charge/i)

  const apiKey = costNote(auth('api_key_env'))
  assert.match(apiKey, /prepaid credit/i)
  assert.notEqual(subscription, apiKey)
})
