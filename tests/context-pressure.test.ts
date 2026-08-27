import test from 'node:test'
import assert from 'node:assert/strict'
import { contextPressure } from '../src/lib/context-pressure'
import type { SessionUsage } from '../shared/types'

/**
 * Measured on a real session before this existed: 104 turns, context reaching
 * ~720k tokens, roughly 36M input tokens spent — and the same work split across
 * four sessions would have cost about a quarter. Nothing had gone wrong, which is
 * why only the bill showed it.
 */

const usage = (inputTokens: number): SessionUsage =>
  ({
    sessionId: 's1',
    turns: 10,
    totals: { inputTokens, outputTokens: 0, totalTokens: inputTokens, cachedReadTokens: 0, reasoningTokens: 0, modelCalls: 1, apiDurationMs: 1 },
    last: { inputTokens, outputTokens: 0, totalTokens: inputTokens, cachedReadTokens: 0, reasoningTokens: 0, modelCalls: 1, apiDurationMs: 1 }
  }) as SessionUsage

const WINDOW = 500_000

test('A SHORT CONVERSATION IS NOT NAGGED', () => {
  const quiet = contextPressure(usage(100_000), WINDOW)
  assert.equal(quiet.level, 'fine')
  assert.equal(quiet.advice, null, 'it spoke when there was nothing worth saying')
})

test('A LONG ONE SAYS SO, AND NAMES THE CHEAPER OPTION', () => {
  const costly = contextPressure(usage(300_000), WINDOW)
  assert.equal(costly.level, 'costly')
  assert.match(costly.advice ?? '', /60%/)
  assert.match(costly.advice ?? '', /new session/i, 'it named a problem without a way out')

  const expensive = contextPressure(usage(450_000), WINDOW)
  assert.equal(expensive.level, 'expensive')
  // The agent's own command. Gronk summarises nothing itself.
  assert.match(expensive.advice ?? '', /\/compact/)
})

test('IT TALKS ABOUT COST, NEVER ABOUT BREAKING', () => {
  // The CLI compacts by itself, so a full context does not fail. Saying otherwise
  // would be the fullness-bar mistake the usage panel already refuses to make, and
  // a warning that cries wolf gets dismissed.
  for (const tokens of [300_000, 450_000, 900_000]) {
    const advice = contextPressure(usage(tokens), WINDOW).advice ?? ''
    assert.doesNotMatch(advice, /fail|break|error|lose|limit reached|run out/i, advice)
  }
})

test('WITH NOTHING TO MEASURE IT SAYS NOTHING', () => {
  // No usage yet, and an agent that never reported a window. Guessing a limit is
  // exactly what the usage panel refuses to do.
  assert.equal(contextPressure(null, WINDOW).advice, null)
  assert.equal(contextPressure(usage(400_000), undefined).advice, null)
  assert.equal(contextPressure(usage(400_000), 0).advice, null)
  assert.equal(contextPressure(usage(0), WINDOW).advice, null)
})

test('THE MEASURE IS THE LAST TURN, NOT THE RUNNING TOTAL', () => {
  // Totals only grow, so they cannot tell a long cheap session from a short
  // expensive one. What was actually sent last turn is the size of the conversation.
  const bigTotalSmallContext: SessionUsage = {
    ...usage(20_000),
    totals: { ...usage(40_000_000).totals }
  }
  assert.equal(contextPressure(bigTotalSmallContext, WINDOW).level, 'fine')
})
