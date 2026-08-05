import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TRANSCRIPT_CACHE_LIMIT,
  cachedTranscript,
  forgetTranscript,
  rememberTranscript,
  type CachedTranscript
} from '../src/lib/transcript-cache'
import type { ChatMessage } from '../shared/types'

/**
 * The last few transcripts the renderer already had.
 *
 * The cache is small on purpose and the tests are mostly about what it refuses
 * to do: grow without bound, hold an empty transcript as though it were an
 * answer, and survive a session being deleted.
 */

function msgs(id: string): ChatMessage[] {
  return [{ id: `${id}-1`, role: 'user', text: id, createdAt: 0 } as ChatMessage]
}

const ids = (cache: CachedTranscript[]) => cache.map((e) => e.sessionId)

test('a transcript comes back out under its own session id', () => {
  const cache = rememberTranscript([], 's1', msgs('s1'))
  assert.deepEqual(cachedTranscript(cache, 's1'), msgs('s1'))
})

test('a session that was never held reads as nothing, so the caller goes to the store', () => {
  const cache = rememberTranscript([], 's1', msgs('s1'))
  assert.equal(cachedTranscript(cache, 's2'), null)
  assert.equal(cachedTranscript([], 's1'), null)
  assert.equal(cachedTranscript(cache, null), null)
})

test('IT IS BOUNDED: the oldest goes when a fourth arrives', () => {
  // Transcripts are capped at 200 messages each and carry tool payloads. An
  // unbounded cache grows with the session list rather than with what the user
  // is actually moving between.
  let cache: CachedTranscript[] = []
  for (const id of ['s1', 's2', 's3', 's4']) cache = rememberTranscript(cache, id, msgs(id))
  assert.equal(cache.length, TRANSCRIPT_CACHE_LIMIT)
  assert.deepEqual(ids(cache), ['s4', 's3', 's2'])
  assert.equal(cachedTranscript(cache, 's1'), null)
})

test('re-remembering moves a session back to the front rather than ageing it out', () => {
  // Otherwise the session being flipped back and forth is the one that gets
  // evicted, which is exactly the case this cache exists for.
  let cache: CachedTranscript[] = []
  for (const id of ['s1', 's2', 's3']) cache = rememberTranscript(cache, id, msgs(id))
  cache = rememberTranscript(cache, 's1', msgs('s1'))
  assert.deepEqual(ids(cache), ['s1', 's3', 's2'])
  cache = rememberTranscript(cache, 's4', msgs('s4'))
  assert.deepEqual(ids(cache), ['s4', 's1', 's3'], 'the session in use was evicted')
})

test('re-remembering replaces the messages rather than keeping the older copy', () => {
  let cache = rememberTranscript([], 's1', msgs('one'))
  cache = rememberTranscript(cache, 's1', msgs('two'))
  assert.equal(cache.length, 1)
  assert.deepEqual(cachedTranscript(cache, 's1'), msgs('two'))
})

test('AN EMPTY TRANSCRIPT IS NOT AN ANSWER, and does not evict one', () => {
  // A session mid-load has no messages yet. Holding that would hand back "this
  // conversation is empty" on the next visit, which is indistinguishable from
  // the truth for a session that really is.
  let cache: CachedTranscript[] = []
  for (const id of ['s1', 's2', 's3']) cache = rememberTranscript(cache, id, msgs(id))
  const after = rememberTranscript(cache, 's4', [])
  assert.equal(after, cache, 'an empty transcript disturbed the cache')
  assert.equal(cachedTranscript(after, 's4'), null)
})

test('no session id is nothing to remember', () => {
  assert.deepEqual(rememberTranscript([], null, msgs('s1')), [])
})

test('forgetting drops one session and leaves the rest', () => {
  // Deleted, archived out of the lists, or renamed: what is held can no longer
  // be trusted to be that session.
  let cache: CachedTranscript[] = []
  for (const id of ['s1', 's2']) cache = rememberTranscript(cache, id, msgs(id))
  const after = forgetTranscript(cache, 's1')
  assert.deepEqual(ids(after), ['s2'])
  assert.equal(cachedTranscript(after, 's1'), null)
})

test('forgetting a session that is not held changes nothing', () => {
  const cache = rememberTranscript([], 's1', msgs('s1'))
  assert.deepEqual(ids(forgetTranscript(cache, 'nope')), ['s1'])
})

test('the cache handed in is never mutated', () => {
  // It lives in a ref and is reassigned, so a function that edited it in place
  // would change state React was never told about.
  const cache = rememberTranscript([], 's1', msgs('s1'))
  const snapshot = ids(cache)
  rememberTranscript(cache, 's2', msgs('s2'))
  forgetTranscript(cache, 's1')
  assert.deepEqual(ids(cache), snapshot)
})

test('a limit of zero holds nothing at all', () => {
  assert.deepEqual(rememberTranscript([], 's1', msgs('s1'), 0), [])
})
