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

/**
 * A turn's reported input is summed across every model round trip it made. That is
 * not the size of the conversation, and dividing it by the window printed a
 * percentage in the thousands on any tool-heavy turn — a number that reads as a
 * broken panel rather than a fact about the session.
 */

const turn = (inputTokens: number, modelCalls: number): any => ({
  sessionId: 's1',
  turns: 1,
  totals: { inputTokens, outputTokens: 0, cachedReadTokens: 0, reasoningTokens: 0, modelCalls, apiDurationMs: 0, costUsd: 0 },
  last: { inputTokens, outputTokens: 0, cachedReadTokens: 0, reasoningTokens: 0, modelCalls, apiDurationMs: 0, costUsd: 0 }
})

test('A TURN IS MEASURED PER ROUND TRIP, NOT BY ITS SUMMED INPUT', () => {
  // Ten round trips over a window that is 40% full is an ordinary tool-heavy turn.
  // Summed it is four whole windows; per round trip it is what was really sent.
  const r = contextPressure(turn(2_000_000, 10), 500_000)
  assert.equal(r.level, 'fine', `a 40%-full conversation reported ${r.level}`)
  assert.equal(r.advice, null)
})

test('THE SHARE STILL RISES WHEN THE CONVERSATION REALLY IS LONG', () => {
  // Same input as a single round trip: that one genuinely did send 400k.
  const r = contextPressure(turn(400_000, 1), 500_000)
  assert.equal(r.level, 'expensive')
  assert.match(r.advice ?? '', /about 80%/)
})

test('NO PERCENTAGE ABOVE 100 EVER REACHES THE SCREEN', () => {
  // What printed four figures before: a turn's summed input taken as its size.
  for (const [input, calls, window] of [
    [29_700_000, 1, 500_000],
    [10_000_000, 2, 128_000],
    [700_000, 1, 500_000]
  ] as const) {
    const r = contextPressure(turn(input, calls), window)
    const pct = Number((r.advice ?? '').match(/about (\d+)%/)?.[1] ?? 0)
    assert.ok(pct > 0, `no percentage in the advice for ${input}/${calls}`)
    assert.ok(pct <= 100, `printed ${pct}% — a share over the window reads as a broken panel`)
  }
})

test('THE REPO OWN CAPTURED SESSION NO LONGER READS AS FOUR FIGURES', () => {
  // 390 round trips across 3 turns, 89.1M input: one turn is 29.7M over 130 calls.
  // Taken whole that is 5940% of a 500k window. Per round trip it is 46%, which is
  // a conversation not yet worth warning about — and it says nothing at all.
  const r = contextPressure(turn(29_700_000, 130), 500_000)
  assert.equal(r.level, 'fine')
  assert.equal(r.advice, null)
})

test('A MISSING OR ZERO ROUND-TRIP COUNT CANNOT DIVIDE BY ZERO', () => {
  for (const calls of [0, undefined as any, -3]) {
    const r = contextPressure(turn(400_000, calls), 500_000)
    assert.ok(Number.isFinite(r.share ?? 0), `share was ${r.share} for modelCalls=${calls}`)
    // Falls back to the raw input rather than vanishing: an unusable count must
    // not turn a full conversation into silence.
    assert.equal(r.level, 'expensive')
  }
})
