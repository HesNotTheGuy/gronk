import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PermissionQueue,
  parsePermissionRequest,
  permissionKey,
  type PendingPermission
} from '../electron/main/agent/permissions'

function pending(partial: Partial<PendingPermission> = {}): PendingPermission {
  return { requestId: 1, options: [], title: 'Allow tool?', ...partial }
}

// ── parsing ────────────────────────────────────────────────────────────────

test('a permission request is read from either field spelling', () => {
  const camel = parsePermissionRequest(7, {
    toolCall: { toolCallId: 't1', title: 'Read file', kind: 'read', rawInput: { path: 'a.ts' } },
    options: [{ optionId: 'allow', kind: 'allow_once' }]
  })
  assert.equal(camel.pending.requestId, 7)
  assert.equal(camel.pending.toolCallId, 't1')
  assert.equal(camel.pending.title, 'Read file')
  assert.equal(camel.pending.kind, 'read')
  assert.deepEqual(camel.pending.rawInput, { path: 'a.ts' })
  assert.equal(camel.pending.options.length, 1)

  const snake = parsePermissionRequest('x', {
    tool_call: { tool_call_id: 't2', title: 'Write file' }
  })
  assert.equal(snake.pending.toolCallId, 't2')
})

test('a request with no title at all still says something the user can act on', () => {
  assert.equal(parsePermissionRequest(1, {}).pending.title, 'Allow tool?')
  assert.equal(
    parsePermissionRequest(1, { title: 'Run command' }).pending.title,
    'Run command'
  )
})

// The dialog is the last thing between the agent and the user's machine, so a
// string payload is shown rather than an anonymous "Allow tool?".
test('a string raw input becomes the title when nothing better exists', () => {
  const long = 'rm -rf '.repeat(40)
  const parsed = parsePermissionRequest(1, { toolCall: { rawInput: long } })
  assert.equal(parsed.pending.title, long.slice(0, 80))
  assert.equal(parsed.pending.title.length, 80)
})

test('options that are not an array are treated as none, never as a decision', () => {
  assert.deepEqual(parsePermissionRequest(1, { options: 'allow' }).pending.options, [])
})

test('the tool card patch is skipped when the request names no tool call', () => {
  assert.equal(parsePermissionRequest(1, { title: 'Something' }).toolCallPatch, null)
})

test('the tool card patch marks the call as awaiting consent', () => {
  const { toolCallPatch } = parsePermissionRequest(1, {
    toolCall: { toolCallId: 't1', title: 'Read file', input: { path: 'a.ts' } }
  })
  assert.deepEqual(toolCallPatch, {
    toolCallId: 't1',
    title: 'Read file',
    status: 'pending',
    rawInput: { path: 'a.ts' }
  })
})

// Documented difference, preserved from the original inline code: the dialog has
// one extra fallback that the card does not.
test('a top-level rawInput reaches the dialog but not the tool card', () => {
  const parsed = parsePermissionRequest(1, {
    toolCall: { toolCallId: 't1' },
    rawInput: { path: 'a.ts' }
  })
  assert.deepEqual(parsed.pending.rawInput, { path: 'a.ts' })
  assert.equal(parsed.toolCallPatch?.rawInput, undefined)
})

// ── queue ──────────────────────────────────────────────────────────────────

test('ids are keyed by string form, so 1 and "1" are the same request', () => {
  assert.equal(permissionKey(1), permissionKey('1'))
})

test('the front of the queue is the oldest unanswered request', () => {
  const queue = new PermissionQueue()
  queue.add(pending({ requestId: 1, title: 'first' }))
  queue.add(pending({ requestId: 2, title: 'second' }))

  assert.equal(queue.front()?.title, 'first')
  assert.equal(queue.size, 2)

  queue.take(1)
  assert.equal(queue.front()?.title, 'second')
})

test('answering out of order removes only that request', () => {
  const queue = new PermissionQueue()
  queue.add(pending({ requestId: 1, title: 'first' }))
  queue.add(pending({ requestId: 2, title: 'second' }))
  queue.add(pending({ requestId: 3, title: 'third' }))

  assert.equal(queue.take(2)?.title, 'second')
  assert.deepEqual(queue.all().map((p) => p.title), ['first', 'third'])
  assert.equal(queue.front()?.title, 'first')
  queue.take(1)
  assert.equal(queue.front()?.title, 'third')
})

// A renderer can answer an id twice (double click, stale dialog). The second
// answer must be a no-op, not a second response on the same JSON-RPC id.
test('an unknown or already-answered id yields nothing to respond to', () => {
  const queue = new PermissionQueue()
  queue.add(pending({ requestId: 1 }))
  assert.ok(queue.take(1))
  assert.equal(queue.take(1), undefined)
  assert.equal(queue.take('nope'), undefined)
  assert.equal(queue.size, 0)
})

test('a numeric id can be answered with its string form', () => {
  const queue = new PermissionQueue()
  queue.add(pending({ requestId: 12 }))
  assert.ok(queue.take('12'))
})

test('re-adding a known id updates it without moving it in the queue', () => {
  const queue = new PermissionQueue()
  queue.add(pending({ requestId: 1, title: 'first' }))
  queue.add(pending({ requestId: 2, title: 'second' }))
  queue.add(pending({ requestId: 1, title: 'first, revised' }))

  assert.equal(queue.size, 2)
  assert.equal(queue.front()?.title, 'first, revised')
})

test('every outstanding request is reachable for the cancel-everything path', () => {
  const queue = new PermissionQueue()
  queue.add(pending({ requestId: 1 }))
  queue.add(pending({ requestId: 2 }))

  assert.deepEqual(queue.all().map((p) => p.requestId), [1, 2])
  queue.clear()
  assert.equal(queue.size, 0)
  assert.equal(queue.front(), undefined)
  assert.deepEqual(queue.all(), [])
})

test('an empty queue has no front, which is what clears the dialog', () => {
  assert.equal(new PermissionQueue().front(), undefined)
})
