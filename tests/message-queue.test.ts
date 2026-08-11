import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { flush, mount } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'
import { QUEUE_LIMIT, useQueue } from '../src/hooks/useQueue'
import type { MainToRendererEvent, SessionInfo } from '../shared/types'

/**
 * A message typed while the agent is working.
 *
 * Send used to be disabled for the whole time a turn ran, so a finished message sat
 * in the box waiting for an end the person typing cannot see coming. Queueing holds
 * it instead of refusing it.
 *
 * Most of what matters here is when the queue must NOT go: into a turn waiting on a
 * permission, or after a turn the user stopped. Both are decisions, and both are
 * cases where sending the message the user queued a minute ago is the opposite of
 * what they now want.
 */

// ── The queue itself ───────────────────────────────────────────────────────

type Hook = ReturnType<typeof useQueue>

async function mountQueue(initial: string | null) {
  let latest: Hook = {} as Hook
  function Probe({ id }: { id: string | null }) {
    latest = useQueue(id)
    return null
  }
  const view = await mount(createElement(Probe, { id: initial }))
  await flush()
  return {
    hook: () => latest,
    setSession: async (id: string | null) => {
      await view.rerender(createElement(Probe, { id }))
      await flush()
    },
    unmount: view.unmount
  }
}

const add = async (h: Awaited<ReturnType<typeof mountQueue>>, text: string) => {
  let ok = false
  await act(async () => {
    ok = h.hook().enqueue(text, [])
  })
  await flush()
  return ok
}

test('MESSAGES GO OUT IN THE ORDER THEY WERE WRITTEN', async () => {
  const h = await mountQueue('a')
  try {
    await add(h, 'first')
    await add(h, 'second')
    assert.deepEqual(
      h.hook().queued.map((m) => m.text),
      ['first', 'second']
    )

    let taken: string | undefined
    await act(async () => {
      taken = h.hook().takeNext()?.text
    })
    await flush()
    assert.equal(taken, 'first')
    assert.deepEqual(
      h.hook().queued.map((m) => m.text),
      ['second'],
      'the message taken is no longer waiting'
    )
  } finally {
    h.unmount()
  }
})

test('THE CAP REFUSES, AND SAYS SO', async () => {
  // Refusing has to be visible: Enter stops doing anything at the cap, so the
  // caller needs to know rather than the message vanishing.
  const h = await mountQueue('a')
  try {
    for (let i = 0; i < QUEUE_LIMIT; i += 1) {
      assert.equal(await add(h, `m${i}`), true, `refused message ${i}, under the cap`)
    }
    assert.equal(h.hook().queueFull, true)
    assert.equal(await add(h, 'one too many'), false, 'accepted past the cap')
    assert.equal(h.hook().queued.length, QUEUE_LIMIT)
  } finally {
    h.unmount()
  }
})

test('AN EMPTY MESSAGE IS NOT A MESSAGE', async () => {
  const h = await mountQueue('a')
  try {
    assert.equal(await add(h, '   '), false)
    assert.equal(h.hook().queued.length, 0)
  } finally {
    h.unmount()
  }
})

test('EACH CONVERSATION HAS ITS OWN QUEUE', async () => {
  const h = await mountQueue('a')
  try {
    await add(h, 'for A')
    await h.setSession('b')
    assert.deepEqual(h.hook().queued, [], "A's queue appeared under B")
    await h.setSession('a')
    assert.deepEqual(
      h.hook().queued.map((m) => m.text),
      ['for A']
    )
  } finally {
    h.unmount()
  }
})

test('A QUEUE WITH NO SESSION TAKES NOTHING', async () => {
  // There is nowhere to send it, and guessing a session is worse than refusing.
  const h = await mountQueue(null)
  try {
    assert.equal(await add(h, 'nowhere to go'), false)
  } finally {
    h.unmount()
  }
})

test('A REMOVED MESSAGE DOES NOT GO', async () => {
  const h = await mountQueue('a')
  try {
    await add(h, 'keep')
    await add(h, 'changed my mind')
    const doomed = h.hook().queued[1].id
    await act(async () => h.hook().removeQueued(doomed))
    await flush()
    assert.deepEqual(
      h.hook().queued.map((m) => m.text),
      ['keep']
    )
  } finally {
    h.unmount()
  }
})

test('A HELD QUEUE STAYS HELD UNTIL SOMETHING RELEASES IT', async () => {
  const h = await mountQueue('a')
  try {
    await add(h, 'queued before the stop')
    assert.equal(h.hook().queueHeld, false)
    await act(async () => h.hook().holdQueue('a'))
    await flush()
    assert.equal(h.hook().queueHeld, true)
    assert.equal(h.hook().queued.length, 1, 'holding threw the message away')

    await act(async () => h.hook().releaseQueue('a'))
    await flush()
    assert.equal(h.hook().queueHeld, false)
  } finally {
    h.unmount()
  }
})

test('A HOLD BELONGS TO ONE CONVERSATION', async () => {
  const h = await mountQueue('a')
  try {
    await act(async () => h.hook().holdQueue('a'))
    await flush()
    await h.setSession('b')
    assert.equal(h.hook().queueHeld, false, "A's stopped turn held B's queue")
  } finally {
    h.unmount()
  }
})

// ── When it actually drains ────────────────────────────────────────────────

type Gronk = Record<string, any>

const session = (id: string): SessionInfo =>
  ({ id, cwd: '/work/alpha', title: id, createdAt: 0, updatedAt: 0, surface: 'project' }) as SessionInfo

async function mountGronk() {
  const bridge = installFakeBridge({})
  const { useGronk } = await import('../src/hooks/useGronk')
  let latest: Gronk = {}
  function Probe() {
    latest = useGronk() as unknown as Gronk
    return null
  }
  const view = await mount(createElement(Probe))
  await flush()
  return { hook: () => latest, emit: bridge.emit, calls: bridge.calls, unmount: view.unmount, restore: bridge.restore }
}

/** Settle into a session, send one prompt, and queue another behind it. */
async function withTurnRunning(h: Awaited<ReturnType<typeof mountGronk>>) {
  await act(async () => {
    await h.hook().selectSession(session('s1'))
  })
  await flush()
  await flush()
  // The agent reporting itself up, which the fake bridge does not do on its own and
  // which sendPrompt refuses without.
  await act(async () => {
    h.emit({ type: 'connection', state: 'ready', sessionId: 's1' } as MainToRendererEvent)
  })
  await flush()
  await act(async () => {
    await h.hook().sendPrompt('the first thing', [])
  })
  await flush()
  assert.equal(h.hook().busy, true, 'the turn did not start')

  await act(async () => {
    h.hook().enqueue('the queued thing', [])
  })
  await flush()
  assert.equal(h.hook().queued.length, 1, 'nothing was queued')
}

const sendCount = (calls: string[]) => calls.filter((c) => c === 'sendPrompt').length

test('A QUEUED MESSAGE GOES WHEN THE TURN FINISHES', async () => {
  const h = await mountGronk()
  try {
    await withTurnRunning(h)
    const before = sendCount(h.calls)

    await act(async () => {
      h.emit({ type: 'message-done', sessionId: 's1', messageId: 'm1' } as MainToRendererEvent)
    })
    await flush()
    await flush()

    assert.equal(sendCount(h.calls), before + 1, 'the queued message never went')
    assert.equal(h.hook().queued.length, 0, 'it is still waiting')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('A STOPPED TURN DOES NOT RELEASE WHAT WAS QUEUED BEHIND IT', async () => {
  // Stopping a turn usually means the user wants to say something different. Firing
  // the message they queued a minute ago into that is the opposite of what they want.
  const h = await mountGronk()
  try {
    await withTurnRunning(h)
    const before = sendCount(h.calls)

    await act(async () => {
      h.emit({
        type: 'message-done',
        sessionId: 's1',
        messageId: 'm1',
        stopReason: 'cancelled'
      } as MainToRendererEvent)
    })
    await flush()
    await flush()

    assert.equal(sendCount(h.calls), before, 'the queue fired after an abort')
    assert.equal(h.hook().queued.length, 1, 'and the message was thrown away instead of held')
    assert.equal(h.hook().queueHeld, true)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('A FAILED TURN HOLDS THE QUEUE TOO', async () => {
  const h = await mountGronk()
  try {
    await withTurnRunning(h)
    const before = sendCount(h.calls)

    await act(async () => {
      h.emit({
        type: 'message-done',
        sessionId: 's1',
        messageId: 'm1',
        stopReason: 'error'
      } as MainToRendererEvent)
    })
    await flush()
    await flush()

    assert.equal(sendCount(h.calls), before, 'the queue fired into a failed turn')
    assert.equal(h.hook().queueHeld, true)
  } finally {
    h.unmount()
    h.restore()
  }
})

test('A TURN WAITING FOR A PERMISSION IS NOT A FINISHED TURN', async () => {
  // The queue must not drain while the agent is waiting for the user to approve
  // something: the approval and the queued prompt would race each other.
  const h = await mountGronk()
  try {
    await withTurnRunning(h)
    const before = sendCount(h.calls)

    await act(async () => {
      h.emit({
        type: 'permission-request',
        sessionId: 's1',
        request: { requestId: 'p1', title: 'Write a file', kind: 'write', options: [] }
      } as unknown as MainToRendererEvent)
      h.emit({ type: 'message-done', sessionId: 's1', messageId: 'm1' } as MainToRendererEvent)
    })
    await flush()
    await flush()

    assert.equal(sendCount(h.calls), before, 'the queue fired over a permission prompt')
    assert.equal(h.hook().queued.length, 1)
  } finally {
    h.unmount()
    h.restore()
  }
})

// ── What the pending messages say for themselves ────────────────────────────

test('A WAITING MESSAGE IS SHOWN IN FULL, WITH ITS OWN CANCEL', async () => {
  // It was a chip that truncated to a few words and read as a status badge. It is the
  // message, so it is shown as one, and every one of them stays cancellable right up to
  // the moment it goes.
  const { Composer } = await import('../src/components/Composer')
  const removed: string[] = []
  const view = await mount(
    createElement(Composer, {
      connection: 'ready',
      hydrating: false,
      busy: true,
      cwd: '/work/alpha',
      draft: { text: '', attachments: [] },
      draftKey: 's1',
      onSend: () => {},
      onCancel: () => {},
      onDraftChange: () => {},
      onDraftSent: () => {},
      onQueue: () => {},
      queued: [
        { id: 'q1', text: 'the first thing I said', attachments: [] },
        { id: 'q2', text: 'and the second', attachments: [] }
      ],
      queueHeld: false,
      onRemoveQueued: (id: string) => removed.push(id)
    } as never)
  )
  try {
    const text = (view.text() || '').replace(/\s+/g, ' ')
    assert.match(text, /the first thing I said/, 'the message itself is not shown')
    assert.match(text, /and the second/)
    assert.match(text, /2 messages waiting/)

    const cancels = view.queryAll('.pending-cancel')
    assert.equal(cancels.length, 2, 'every waiting message needs its own cancel')
    await view.click(cancels[1])
    assert.deepEqual(removed, ['q2'], 'cancelling took the wrong one')
  } finally {
    view.unmount()
  }
})

test('STOP SAYS WHICH TURN IT STOPS WHEN MESSAGES ARE WAITING', async () => {
  // The maintainer's point: "abort" does not read as abort when something is queued
  // behind it — the obvious guess is that the next one then starts. It does not.
  const { Composer } = await import('../src/components/Composer')
  const withQueue = {
    connection: 'ready',
    hydrating: false,
    busy: true,
    cwd: '/work/alpha',
    draft: { text: '', attachments: [] },
    draftKey: 's1',
    onSend: () => {},
    onCancel: () => {},
    onDraftChange: () => {},
    onDraftSent: () => {},
    onQueue: () => {},
    queueHeld: false,
    onRemoveQueued: () => {}
  }

  const queued = await mount(
    createElement(Composer, {
      ...withQueue,
      queued: [{ id: 'q1', text: 'waiting', attachments: [] }]
    } as never)
  )
  const alone = await mount(createElement(Composer, { ...withQueue, queued: [] } as never))
  try {
    assert.match((queued.text() || '').replace(/\s+/g, ' '), /Stop this turn/)
    assert.match(
      (queued.text() || '').replace(/\s+/g, ' '),
      /Stop keeps it waiting/,
      'nothing tells the user what happens to the queued message'
    )
    assert.match((alone.text() || '').replace(/\s+/g, ' '), /Abort/, 'plain Abort was lost')
  } finally {
    queued.unmount()
    alone.unmount()
  }
})
