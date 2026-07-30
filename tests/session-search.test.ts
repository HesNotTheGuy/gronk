import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSnippet,
  parseQuery,
  rankHits,
  scoreSession
} from '../shared/session-search'
import type { ChatMessage, SessionInfo } from '../shared/types'

function session(partial: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 's1',
    cwd: '/p',
    title: 'Rate limiter drops bursts',
    createdAt: 1000,
    updatedAt: 2000,
    ...partial
  }
}

function msg(partial: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm1', role: 'assistant', text: '', createdAt: 1000, ...partial }
}

test('an empty or whitespace query yields no terms, and so no matches', () => {
  assert.deepEqual(parseQuery('   '), [])
  assert.equal(scoreSession(session(), [], []), null)
  assert.equal(scoreSession(session(), [msg({ text: 'anything' })], parseQuery('  ')), null)
})

test('query terms are lowercased and split on any whitespace', () => {
  assert.deepEqual(parseQuery('  Rate   LIMITER\tbursts '), ['rate', 'limiter', 'bursts'])
})

// A second word must narrow the result set. If terms were OR-ed, adding detail
// would return more rows, which is the opposite of what typing more means.
test('every term must appear, so a second word narrows', () => {
  const messages = [msg({ text: 'the token bucket never refills' })]
  assert.ok(scoreSession(session(), messages, parseQuery('token bucket')))
  assert.equal(scoreSession(session(), messages, parseQuery('token semaphore')), null)
})

test('matching is case-insensitive in both title and body', () => {
  assert.ok(scoreSession(session({ title: 'Rate Limiter' }), [], parseQuery('rate limiter')))
  assert.ok(scoreSession(session({ title: '' }), [msg({ text: 'REFILL' })], parseQuery('refill')))
})

test('a title hit outranks any number of body hits', () => {
  const titleOnly = scoreSession(session({ title: 'refill logic' }), [], parseQuery('refill'))
  const manyBodies = scoreSession(
    session({ title: 'unrelated' }),
    Array.from({ length: 40 }, () => msg({ text: 'refill' })),
    parseQuery('refill')
  )
  assert.ok(titleOnly && manyBodies)
  assert.ok(titleOnly.score > manyBodies.score)
  assert.equal(titleOnly.inTitle, true)
  assert.equal(manyBodies.inTitle, false)
})

test('body matches are counted, and the count is capped so it cannot beat a title', () => {
  const hit = scoreSession(
    session({ title: 'unrelated' }),
    Array.from({ length: 200 }, () => msg({ text: 'refill' })),
    parseQuery('refill')
  )
  assert.ok(hit)
  assert.equal(hit.messageMatches, 200)
  assert.ok(hit.score < 1000, 'capped body score must stay below a title hit')
})

// Reasoning frequently names the file or symbol the visible answer only alludes
// to, so it is searched as well.
test('a term found only in a thought still matches', () => {
  const hit = scoreSession(
    session({ title: 'unrelated' }),
    [msg({ text: 'I fixed it', thought: 'the culprit is lastRefill' })],
    parseQuery('lastrefill')
  )
  assert.ok(hit)
  assert.equal(hit.messageMatches, 1)
})

test('a session with no match at all returns null', () => {
  assert.equal(
    scoreSession(session({ title: 'unrelated' }), [msg({ text: 'nothing here' })], parseQuery('refill')),
    null
  )
})

// ── snippets ───────────────────────────────────────────────────────────────

test('a snippet centres on the earliest matching term', () => {
  const snippet = buildSnippet('alpha beta gamma delta refill epsilon zeta', parseQuery('refill'))
  assert.ok(snippet)
  assert.match(snippet, /refill/)
})

test('a snippet collapses newlines so a row cannot break the layout', () => {
  const snippet = buildSnippet('one\n\n\ttwo   refill\nthree', parseQuery('refill'))
  assert.ok(snippet)
  assert.ok(!snippet.includes('\n'))
  assert.ok(!snippet.includes('\t'))
})

test('a long match is elided on both sides, a short one on neither', () => {
  const long = buildSnippet(`${'x '.repeat(200)}refill${' y'.repeat(200)}`, parseQuery('refill'))
  assert.ok(long?.startsWith('…') && long?.endsWith('…'))

  const short = buildSnippet('just refill here', parseQuery('refill'))
  assert.equal(short, 'just refill here')
})

test('an empty body yields no snippet rather than an empty ellipsis', () => {
  assert.equal(buildSnippet('   ', parseQuery('refill')), null)
  assert.equal(buildSnippet('has text but no term', parseQuery('refill')), null)
})

// ── ranking ────────────────────────────────────────────────────────────────

test('equal scores fall back to most recently updated', () => {
  const sessions = [
    session({ id: 'old', updatedAt: 100 }),
    session({ id: 'new', updatedAt: 900 })
  ]
  const hits = [
    { sessionId: 'old', inTitle: false, messageMatches: 1, snippet: null, score: 1 },
    { sessionId: 'new', inTitle: false, messageMatches: 1, snippet: null, score: 1 }
  ]
  assert.deepEqual(rankHits(hits, sessions).map((h) => h.sessionId), ['new', 'old'])
})

test('score wins over recency', () => {
  const sessions = [
    session({ id: 'titleHit', updatedAt: 1 }),
    session({ id: 'bodyHit', updatedAt: 9999 })
  ]
  const hits = [
    { sessionId: 'bodyHit', inTitle: false, messageMatches: 3, snippet: null, score: 3 },
    { sessionId: 'titleHit', inTitle: true, messageMatches: 0, snippet: null, score: 1000 }
  ]
  assert.deepEqual(rankHits(hits, sessions).map((h) => h.sessionId), ['titleHit', 'bodyHit'])
})

test('ranking does not mutate the array it was given', () => {
  const hits = [
    { sessionId: 'a', inTitle: false, messageMatches: 1, snippet: null, score: 1 },
    { sessionId: 'b', inTitle: true, messageMatches: 0, snippet: null, score: 1000 }
  ]
  const before = hits.map((h) => h.sessionId)
  rankHits(hits, [session({ id: 'a' }), session({ id: 'b' })])
  assert.deepEqual(hits.map((h) => h.sessionId), before)
})

test('a hit for a session missing from the list still ranks, treated as oldest', () => {
  const hits = [
    { sessionId: 'known', inTitle: false, messageMatches: 1, snippet: null, score: 1 },
    { sessionId: 'ghost', inTitle: false, messageMatches: 1, snippet: null, score: 1 }
  ]
  const ranked = rankHits(hits, [session({ id: 'known', updatedAt: 5 })])
  assert.deepEqual(ranked.map((h) => h.sessionId), ['known', 'ghost'])
})
