import test from 'node:test'
import assert from 'node:assert/strict'
import { MOUNT_TAIL, prependHead, splitForMount } from '../src/lib/transcript-mount'
import type { ChatMessage } from '../shared/types'

/**
 * Painting a restored transcript end first.
 *
 * Two properties carry the whole change. Nothing may be lost or reordered by
 * the split, and the late half must refuse to land on a transcript that has
 * moved on without it. The second is the one that turns a latency fix into a
 * corruption: a head appended to the wrong list puts one session's history in
 * front of another's, and the result is persisted 400ms later.
 */

function msg(id: string, role: ChatMessage['role'] = 'user'): ChatMessage {
  return { id, role, text: id, createdAt: 0 } as ChatMessage
}

const LONG = Array.from({ length: 200 }, (_, i) => msg(`m${i}`))

test('a transcript that already fits is painted whole, with nothing scheduled', () => {
  // Not an empty head: the caller schedules on `head.length`, and a second
  // update carrying nothing is still a second render of the whole list.
  const short = LONG.slice(0, MOUNT_TAIL)
  const split = splitForMount(short)
  assert.equal(split.tail, short, 'the array was copied for no reason')
  assert.deepEqual(split.head, [])
  assert.equal(split.anchorId, null)
})

test('an empty transcript splits into nothing', () => {
  assert.deepEqual(splitForMount([]), { tail: [], head: [], anchorId: null })
})

test('THE SPLIT LOSES NOTHING: head then tail is the original, in order', () => {
  const { tail, head } = splitForMount(LONG)
  assert.equal(tail.length, MOUNT_TAIL)
  assert.equal(head.length, LONG.length - MOUNT_TAIL)
  assert.deepEqual([...head, ...tail], LONG)
})

test('the tail is the END of the transcript, which is what the reader is looking at', () => {
  // Painting the first 30 instead would put the user at the top of a
  // conversation they were at the bottom of.
  const { tail } = splitForMount(LONG)
  assert.equal(tail[tail.length - 1].id, 'm199')
  assert.equal(tail[0].id, 'm170')
})

test('the anchor is the first message painted', () => {
  const { tail, anchorId } = splitForMount(LONG)
  assert.equal(anchorId, tail[0].id)
})

test('a tail size of zero or less paints everything at once', () => {
  // The escape hatch: no split, no scheduling, current behaviour exactly.
  for (const size of [0, -1]) {
    const split = splitForMount(LONG, size)
    assert.equal(split.tail, LONG)
    assert.deepEqual(split.head, [])
    assert.equal(split.anchorId, null)
  }
})

test('the head goes back in front', () => {
  const { tail, head, anchorId } = splitForMount(LONG)
  assert.deepEqual(prependHead(tail, head, anchorId), LONG)
})

test('THE WRONG TRANSCRIPT IS REFUSED, not guessed at', () => {
  // The user switched session while the head was still waiting. Appending here
  // would put one conversation's history in front of another's.
  const { head, anchorId } = splitForMount(LONG)
  const other = [msg('other-1'), msg('other-2')]
  assert.equal(prependHead(other, head, anchorId), other, 'a foreign transcript was rewritten')
})

test('a cleared transcript is left cleared', () => {
  const { head, anchorId } = splitForMount(LONG)
  const empty: ChatMessage[] = []
  assert.equal(prependHead(empty, head, anchorId), empty)
})

test('a transcript that already has its head is not given a second one', () => {
  const { head, anchorId } = splitForMount(LONG)
  // The whole transcript, i.e. the head has landed. It starts with head[0], not
  // with the anchor, so there is nothing to do.
  assert.equal(prependHead(LONG, head, anchorId), LONG, 'the head was applied twice')
})

test('messages sent while the head was waiting stay at the end', () => {
  // A prompt typed during the restore. It belongs after everything, and the
  // head belongs in front of all of it.
  const { tail, head, anchorId } = splitForMount(LONG)
  const sent = msg('typed-during-restore')
  const merged = prependHead([...tail, sent], head, anchorId)
  assert.deepEqual(merged, [...LONG, sent])
})

test('nothing to append returns the very same array, which is how "done" is read', () => {
  // Reference equality, not deep equality: the caller uses `merged === current`
  // to decide the pending head has landed and can be dropped.
  const current = [msg('a')]
  assert.equal(prependHead(current, [], 'a'), current)
  assert.equal(prependHead(current, [msg('h')], null), current)
})
