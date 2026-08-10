import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { __freshUserData } from './stubs/electron'
import {
  getTranscript,
  keepHistory,
  saveTranscript,
  upsertSession
} from '../electron/main/store'
import type { ChatMessage, SessionInfo } from '../shared/types'

/**
 * A save can never replace a stored conversation with a shorter, different one.
 *
 * This is not hypothetical. Three of the maintainer's sessions were reduced to a
 * single message each on a real machine: 4 -> 1, 15 -> 2, 29 -> 1, with no id in
 * common between what was stored and what remained. `persistLiveTranscript`
 * writes `liveMessages`, which starts empty on a boot, so resuming a session and
 * finishing one turn wrote a one-message transcript over the whole history.
 *
 * The class had been fixed here before, path by path, with tests named for it.
 * It returned through a path nobody had pinned, which is why the rule now lives
 * at the write rather than in the callers.
 */

let userData: string

beforeEach(() => {
  userData = __freshUserData()
  void userData
})

const msg = (id: string, role: ChatMessage['role'] = 'user'): ChatMessage =>
  ({ id, role, text: id, createdAt: 1 }) as ChatMessage

const session = (id: string): SessionInfo => ({
  id,
  cwd: '/work/alpha',
  title: id,
  createdAt: 1,
  updatedAt: 1,
  surface: 'project'
})

test('THE REPORTED LOSS: a one-message save over a long transcript keeps the history', () => {
  upsertSession(session('s1'))
  saveTranscript('s1', [msg('a'), msg('b'), msg('c'), msg('d')])
  assert.equal(getTranscript('s1').length, 4)

  // Exactly what a resumed session with an empty liveMessages array offers after
  // one completed turn.
  saveTranscript('s1', [msg('new-1', 'assistant')])

  const after = getTranscript('s1')
  assert.deepEqual(
    after.map((m) => m.id),
    ['a', 'b', 'c', 'd', 'new-1'],
    'the history was replaced instead of appended to'
  )
})

test('growing a conversation is untouched', () => {
  upsertSession(session('s1'))
  saveTranscript('s1', [msg('a'), msg('b')])
  saveTranscript('s1', [msg('a'), msg('b'), msg('c')])
  assert.deepEqual(getTranscript('s1').map((m) => m.id), ['a', 'b', 'c'])
})

test('the 200-message cap still drops the oldest, because it is not a shrink', () => {
  upsertSession(session('s1'))
  const first = Array.from({ length: 200 }, (_, i) => msg(`m${i}`))
  saveTranscript('s1', first)
  assert.equal(getTranscript('s1').length, 200)

  // A conversation at the cap that grows: the incoming array is trimmed to 200,
  // so it arrives the same length as what is stored rather than shorter.
  saveTranscript('s1', [...first, msg('m200'), msg('m201')])
  const after = getTranscript('s1')
  assert.equal(after.length, 200)
  assert.equal(after.at(-1)?.id, 'm201', 'the newest turn must survive the cap')
  assert.equal(after[0].id, 'm2', 'and the oldest two are the ones dropped')
})

test('removing duplicates is allowed: it drops ids and introduces none', () => {
  assert.deepEqual(
    keepHistory([msg('a'), msg('a'), msg('b')], [msg('a'), msg('b')]).map((m) => m.id),
    ['a', 'b']
  )
})

test('a shorter save that is a pure subset is allowed', () => {
  assert.deepEqual(
    keepHistory([msg('a'), msg('b'), msg('c')], [msg('a'), msg('b')]).map((m) => m.id),
    ['a', 'b']
  )
})

test('an empty save over a stored conversation cannot erase it', () => {
  upsertSession(session('s1'))
  saveTranscript('s1', [msg('a'), msg('b')])
  saveTranscript('s1', [])
  assert.deepEqual(getTranscript('s1').map((m) => m.id), ['a', 'b'])
})

test('a first save is stored as given', () => {
  assert.deepEqual(keepHistory([], [msg('a')]).map((m) => m.id), ['a'])
})

test('the merge is still capped, so a refusal cannot grow the store without bound', () => {
  const stored = Array.from({ length: 200 }, (_, i) => msg(`s${i}`))
  const merged = keepHistory(stored, [msg('brand-new', 'assistant')])
  assert.equal(merged.length, 200)
  assert.equal(merged.at(-1)?.id, 'brand-new')
})
