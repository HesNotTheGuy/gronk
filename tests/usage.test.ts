import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addTurnUsage,
  COST_USD_TICKS_PER_USD,
  emptyTurnUsage,
  parseTurnUsageFromUpdate,
  SessionUsageTracker
} from '../electron/main/acp/client'

/**
 * Captured verbatim from a real `grok agent stdio` session. Field names are
 * camelCase inside `usage` but snake_case beside it — the parser must not assume
 * one convention, so this payload is the fixture the rest of the file builds on.
 */
function turnCompleted(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionUpdate: 'turn_completed',
    prompt_id: '5d55a944-0000-4000-8000-000000000001',
    stop_reason: 'end_turn',
    usage: {
      inputTokens: 44861,
      outputTokens: 567,
      totalTokens: 45428,
      cachedReadTokens: 28288,
      reasoningTokens: 211,
      modelCalls: 3,
      apiDurationMs: 10559,
      costUsdTicks: 450344000,
      modelUsage: {
        'grok-4.5-build': {
          inputTokens: 44861,
          outputTokens: 567,
          totalTokens: 45428,
          cachedReadTokens: 28288,
          reasoningTokens: 211,
          costUsdTicks: 450344000
        }
      }
    },
    ...overrides
  }
}

test('the real turn_completed payload parses field for field', () => {
  const parsed = parseTurnUsageFromUpdate(turnCompleted())
  assert.ok(parsed)
  assert.equal(parsed.promptId, '5d55a944-0000-4000-8000-000000000001')
  assert.equal(parsed.stopReason, 'end_turn')
  assert.equal(parsed.usage.inputTokens, 44861)
  assert.equal(parsed.usage.outputTokens, 567)
  assert.equal(parsed.usage.totalTokens, 45428)
  assert.equal(parsed.usage.cachedReadTokens, 28288)
  assert.equal(parsed.usage.reasoningTokens, 211)
  assert.equal(parsed.usage.modelCalls, 3)
  assert.equal(parsed.usage.apiDurationMs, 10559)
})

// Nano-USD is an inference about a third-party field, so the conversion is
// pinned here: if the CLI changes scale, this is what should fail first.
test('costUsdTicks converts at one billion ticks per dollar', () => {
  const parsed = parseTurnUsageFromUpdate(turnCompleted())
  assert.equal(COST_USD_TICKS_PER_USD, 1_000_000_000)
  assert.equal(parsed?.usage.costUsd, 0.450344)
})

test('per-model usage is kept so a multi-model turn stays attributable', () => {
  const parsed = parseTurnUsageFromUpdate(turnCompleted())
  assert.deepEqual(parsed?.usage.perModel, {
    'grok-4.5-build': { totalTokens: 45428, costUsd: 0.450344 }
  })
})

test('snake_case field names inside usage parse too', () => {
  const parsed = parseTurnUsageFromUpdate({
    sessionUpdate: 'turn_completed',
    promptId: 'p1',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      cached_read_tokens: 60,
      reasoning_tokens: 5,
      model_calls: 2,
      api_duration_ms: 900,
      cost_usd_ticks: 2_000_000_000
    }
  })
  assert.equal(parsed?.promptId, 'p1')
  assert.equal(parsed?.usage.inputTokens, 100)
  assert.equal(parsed?.usage.cachedReadTokens, 60)
  assert.equal(parsed?.usage.modelCalls, 2)
  assert.equal(parsed?.usage.costUsd, 2)
})

test('a missing totalTokens is derived from input + output', () => {
  const parsed = parseTurnUsageFromUpdate({
    sessionUpdate: 'turn_completed',
    usage: { inputTokens: 40, outputTokens: 2 }
  })
  assert.equal(parsed?.usage.totalTokens, 42)
})

test('updates that are not turn_completed are ignored', () => {
  assert.equal(parseTurnUsageFromUpdate({ sessionUpdate: 'agent_message_chunk' }), null)
  assert.equal(parseTurnUsageFromUpdate({}), null)
})

// Accounting is secondary to the app working: bad data must yield nothing at all.
test('missing or garbage usage yields nothing rather than zeros or NaN', () => {
  const bad: unknown[] = [
    undefined,
    null,
    'a lot',
    42,
    [],
    {},
    { inputTokens: 'many', outputTokens: null },
    { inputTokens: Number.NaN, totalTokens: Number.POSITIVE_INFINITY },
    { inputTokens: -5 }
  ]
  for (const usage of bad) {
    assert.equal(
      parseTurnUsageFromUpdate({ sessionUpdate: 'turn_completed', usage }),
      null,
      `usage ${JSON.stringify(usage)} should not parse`
    )
  }
})

test('one unreadable field does not discard the readable ones', () => {
  const parsed = parseTurnUsageFromUpdate({
    sessionUpdate: 'turn_completed',
    usage: { inputTokens: 10, outputTokens: 'nope', modelCalls: null, totalTokens: 10 }
  })
  assert.equal(parsed?.usage.inputTokens, 10)
  assert.equal(parsed?.usage.outputTokens, 0)
  assert.equal(parsed?.usage.modelCalls, 0)
  assert.ok(!Number.isNaN(parsed?.usage.totalTokens))
})

test('a garbage modelUsage block is dropped, not thrown on', () => {
  for (const modelUsage of ['x', 7, [], { 'grok-4.5-build': 'nope' }]) {
    const parsed = parseTurnUsageFromUpdate({
      sessionUpdate: 'turn_completed',
      usage: { inputTokens: 1, outputTokens: 1, modelUsage }
    })
    assert.equal(parsed?.usage.perModel, undefined)
  }
})

// A cost of zero is "not reported", not "free" — $0.00 would state more than the
// payload says, and the UI keys off `costUsd` being absent.
test('a zero or absent costUsdTicks yields no cost at all', () => {
  for (const usage of [
    { inputTokens: 1, outputTokens: 1 },
    { inputTokens: 1, outputTokens: 1, costUsdTicks: 0 },
    { inputTokens: 1, outputTokens: 1, costUsdTicks: 'free' },
    { inputTokens: 1, outputTokens: 1, costUsdTicks: -100 }
  ]) {
    const parsed = parseTurnUsageFromUpdate({ sessionUpdate: 'turn_completed', usage })
    assert.equal(parsed?.usage.costUsd, undefined)
  }
})

test('adding turns leaves cost absent until one turn reports it', () => {
  const free = parseTurnUsageFromUpdate({
    sessionUpdate: 'turn_completed',
    usage: { inputTokens: 5, outputTokens: 1 }
  })!.usage
  assert.equal(addTurnUsage(emptyTurnUsage(), free).costUsd, undefined)

  const paid = parseTurnUsageFromUpdate(turnCompleted())!.usage
  assert.equal(addTurnUsage(addTurnUsage(emptyTurnUsage(), free), paid).costUsd, 0.450344)
})

test('a tracker with no turns has no snapshot to show', () => {
  const tracker = new SessionUsageTracker()
  assert.equal(tracker.snapshot(), null)
  assert.equal(tracker.add('s1', { sessionUpdate: 'agent_message_chunk' }), null)
  assert.equal(tracker.snapshot(), null)
})

test('totals sum across turns and the last turn stays separate', () => {
  const tracker = new SessionUsageTracker()
  tracker.add('s1', turnCompleted({ prompt_id: 'a' }))
  const usage = tracker.add(
    's1',
    turnCompleted({
      prompt_id: 'b',
      usage: {
        inputTokens: 1000,
        outputTokens: 100,
        totalTokens: 1100,
        cachedReadTokens: 500,
        reasoningTokens: 10,
        modelCalls: 1,
        apiDurationMs: 2000,
        costUsdTicks: 50_000_000
      }
    })
  )

  assert.ok(usage)
  assert.equal(usage.sessionId, 's1')
  assert.equal(usage.turns, 2)
  assert.equal(usage.totals.inputTokens, 45861)
  assert.equal(usage.totals.totalTokens, 46528)
  assert.equal(usage.totals.cachedReadTokens, 28788)
  assert.equal(usage.totals.modelCalls, 4)
  assert.equal(usage.totals.apiDurationMs, 12559)
  // Summed dollars are floating point; the estimate only has to be right, not bit-exact.
  assert.ok(Math.abs((usage.totals.costUsd ?? 0) - 0.500344) < 1e-9)
  // "This turn" is the newest turn only — never the running total.
  assert.equal(usage.last?.totalTokens, 1100)
})

// A turn's usage is a snapshot of that turn, so a re-delivered update (history
// replay, duplicated notification) must not be added a second time.
test('a repeated prompt_id does not double-count', () => {
  const tracker = new SessionUsageTracker()
  const first = tracker.add('s1', turnCompleted())
  assert.equal(first?.turns, 1)

  assert.equal(tracker.add('s1', turnCompleted()), null)
  assert.equal(tracker.snapshot()?.turns, 1)
  assert.equal(tracker.snapshot()?.totals.totalTokens, 45428)
})

test('turns without a prompt_id are still counted', () => {
  const tracker = new SessionUsageTracker()
  tracker.add('s1', turnCompleted({ prompt_id: undefined }))
  tracker.add('s1', turnCompleted({ prompt_id: undefined }))
  assert.equal(tracker.snapshot()?.turns, 2)
  assert.equal(tracker.snapshot()?.totals.totalTokens, 90856)
})

test('a different session starts its totals from zero', () => {
  const tracker = new SessionUsageTracker()
  tracker.add('s1', turnCompleted({ prompt_id: 'a' }))
  const next = tracker.add('s2', turnCompleted({ prompt_id: 'b' }))

  assert.equal(next?.sessionId, 's2')
  assert.equal(next?.turns, 1)
  assert.equal(next?.totals.totalTokens, 45428)
})

// The same prompt_id in a new session is a different turn; dedup must not leak.
test('reset clears totals and the prompt_id memory', () => {
  const tracker = new SessionUsageTracker()
  tracker.add('s1', turnCompleted())
  tracker.reset()
  assert.equal(tracker.snapshot(), null)

  const again = tracker.add('s1', turnCompleted())
  assert.equal(again?.turns, 1)
})

test('per-model totals merge across turns', () => {
  const tracker = new SessionUsageTracker()
  tracker.add('s1', turnCompleted({ prompt_id: 'a' }))
  const usage = tracker.add('s1', turnCompleted({ prompt_id: 'b' }))
  assert.deepEqual(usage?.totals.perModel, {
    'grok-4.5-build': { totalTokens: 90856, costUsd: 0.900688 }
  })
})

test('an empty session id is never counted', () => {
  const tracker = new SessionUsageTracker()
  assert.equal(tracker.add('', turnCompleted()), null)
  assert.equal(tracker.snapshot(), null)
})
