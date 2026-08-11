import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { ensureDom, flush, mount } from './helpers/render'
import { Composer } from '../src/components/Composer'
import { EMPTY_DRAFT, useDrafts, type Draft } from '../src/hooks/useDrafts'
import type { PromptAttachment } from '../shared/types'

/**
 * A message typed and not sent.
 *
 * Two failures, opposite directions, one cause: the text used to belong to the
 * composer rather than to a conversation. Leaving the conversation view unmounts
 * the composer, so going Home threw a written message away. A session switch does
 * NOT unmount it, so the message was still in the box when another conversation
 * opened — one Enter from the wrong agent.
 *
 * Some of what follows types into the box and some drives the draft handed down. The
 * difference is worth knowing: React 19's change plugin does not synthesize `onChange`
 * from a dispatched input event outside a real browser, so a composer on `onChange`
 * could not be typed into at all — which is why it is on `onInput`, matching the
 * project-notes box. Assigning `el.value` directly is still useless: it updates the DOM
 * without telling React, so the box reads back what the test wrote while the state is
 * empty, and assertions about it pass for no reason. The helper below uses the
 * prototype setter and a real input event.
 */

const props = (over: Record<string, unknown> = {}) =>
  ({
    hydrating: false,
    busy: false,
    connection: 'ready',
    cwd: '/work/alpha',
    permissionMode: 'default',
    draft: EMPTY_DRAFT,
    draftKey: 's1',
    onSend: () => {},
    onCancel: () => {},
    onDraftChange: () => {},
    onDraftSent: () => {},
    onQueue: () => {},
    queued: [],
    queueHeld: false,
    onRemoveQueued: () => {},
    ...over
  }) as never

const box = (view: { query: (s: string) => Element | null }) =>
  view.query('textarea') as HTMLTextAreaElement

const draftOf = (text: string): Draft => ({ text, attachments: [] })

/** Type the way a person does: the prototype setter, then a real input event. */
async function type(el: Element, text: string): Promise<void> {
  const window = ensureDom().window
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )?.set
  assert.ok(setter, 'jsdom has no textarea value setter')
  await act(async () => {
    setter.call(el, text)
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await flush()
}

// ── The composer and the draft handed to it ─────────────────────────────────

test('THE BOX SHOWS THE MESSAGE WRITTEN FOR THE CONVERSATION ON SCREEN', async () => {
  const view = await mount(createElement(Composer, props({ draft: draftOf('where I left off') })))
  try {
    assert.equal(box(view).value, 'where I left off')
  } finally {
    view.unmount()
  }
})

test('SWITCHING CONVERSATION SWAPS THE BOX OVER', async () => {
  // The composer is not remounted between sessions, so without the swap the
  // message written for one conversation is sitting in the next one's box.
  const view = await mount(createElement(Composer, props({ draft: draftOf('meant for the first') })))
  try {
    await view.rerender(createElement(Composer, props({ draftKey: 's2', draft: EMPTY_DRAFT })))
    await flush()
    assert.equal(box(view).value, '', "the first conversation's message came along")

    await view.rerender(
      createElement(Composer, props({ draftKey: 's1', draft: draftOf('meant for the first') }))
    )
    await flush()
    assert.equal(box(view).value, 'meant for the first', 'and coming back put it back')
  } finally {
    view.unmount()
  }
})

test('A NEW DRAFT FOR THE SAME CONVERSATION DOES NOT FIGHT WHAT IS BEING TYPED', async () => {
  // The swap is keyed on the conversation, not on the draft value, because the
  // draft prop arrives back a beat after every keystroke. Re-applying it on value
  // would overwrite the box from a stale copy mid-sentence.
  const view = await mount(createElement(Composer, props({ draft: draftOf('first') })))
  try {
    await view.rerender(createElement(Composer, props({ draft: draftOf('a later echo') })))
    await flush()
    assert.equal(box(view).value, 'first', 'the box was overwritten from the draft prop')
  } finally {
    view.unmount()
  }
})

test('LEAVING THE CONVERSATION HANDS THE DRAFT BACK', async () => {
  // Going Home unmounts the composer, and that gesture was the whole loss. This
  // pins that unmounting writes; it cannot pin that unsent keystrokes survive,
  // because typing cannot be driven here.
  const handed: Draft[] = []
  const view = await mount(
    createElement(
      Composer,
      props({ draft: draftOf('unfinished'), onDraftChange: (d: Draft) => handed.push(d) })
    )
  )
  view.unmount()
  await flush()

  assert.ok(handed.length > 0, 'unmounting handed nothing back')
  assert.equal(handed[handed.length - 1].text, 'unfinished')
})

test('A SENT MESSAGE IS CLEARED, AND NOT HANDED BACK ON THE WAY OUT', async () => {
  const handed: Draft[] = []
  const sends: string[] = []
  let cleared = 0
  const view = await mount(
    createElement(
      Composer,
      props({
        draft: draftOf('this one is going'),
        onSend: (text: string) => sends.push(text),
        onDraftChange: (d: Draft) => handed.push(d),
        onDraftSent: () => (cleared += 1)
      })
    )
  )

  const send = view.query('.composer-actions .btn-primary') ?? view.query('.btn-primary')
  assert.ok(send, 'no Send button')
  assert.equal((send as HTMLButtonElement).disabled, false, 'Send was not offered')
  await view.click(send)
  await flush()

  assert.deepEqual(sends, ['this one is going'])
  assert.equal(cleared, 1, 'the draft was cleared with the message')
  assert.equal(box(view).value, '', 'and the box emptied')

  view.unmount()
  await flush()
  assert.ok(
    !handed.some((d) => d.text === 'this one is going'),
    'a sent message came back as an unsent draft'
  )
})

// ── The store behind it ────────────────────────────────────────────────────

type Hook = ReturnType<typeof useDrafts>

async function mountDrafts(initial: string | null) {
  let latest: Hook = {} as Hook
  let session = initial
  function Probe({ id }: { id: string | null }) {
    latest = useDrafts(id)
    return null
  }
  const view = await mount(createElement(Probe, { id: session }))
  await flush()
  return {
    hook: () => latest,
    setSession: async (id: string | null) => {
      session = id
      await view.rerender(createElement(Probe, { id: session }))
      await flush()
    },
    unmount: view.unmount
  }
}

test('EACH CONVERSATION KEEPS ITS OWN MESSAGE', async () => {
  const h = await mountDrafts('a')
  try {
    await act(async () => h.hook().setDraft(draftOf('for A')))
    await flush()
    assert.equal(h.hook().draft.text, 'for A')

    await h.setSession('b')
    assert.equal(h.hook().draft.text, '', "A's message appeared under B")

    await act(async () => h.hook().setDraft(draftOf('for B')))
    await flush()
    await h.setSession('a')
    assert.equal(h.hook().draft.text, 'for A', 'going back lost it')
  } finally {
    h.unmount()
  }
})

test('A MESSAGE TYPED WHILE A SESSION IS STILL BOOTING IS ADOPTED BY IT', async () => {
  // Typing is allowed before the agent answers, and the id only exists once it
  // does. Without somewhere to put those keystrokes they would be dropped at the
  // moment the session became real.
  const h = await mountDrafts(null)
  try {
    await act(async () => h.hook().setDraft(draftOf('typed while it was opening')))
    await flush()
    await h.setSession('booted')
    assert.equal(h.hook().draft.text, 'typed while it was opening')

    // And it belongs to that session alone now, not to the next one to open.
    await h.setSession('somebody-else')
    assert.equal(h.hook().draft.text, '', 'the unnamed draft was handed out twice')
  } finally {
    h.unmount()
  }
})

test('SENDING LEAVES NOTHING TO RESTORE', async () => {
  const h = await mountDrafts('a')
  try {
    await act(async () => h.hook().setDraft(draftOf('going')))
    await flush()
    await act(async () => h.hook().clearDraft())
    await flush()
    assert.equal(h.hook().draft.text, '')
  } finally {
    h.unmount()
  }
})

test('A DELETED CONVERSATION FORGETS ITS MESSAGE', async () => {
  const h = await mountDrafts('a')
  try {
    await act(async () => h.hook().setDraft(draftOf('for a session about to go')))
    await flush()
    await act(async () => h.hook().forgetDraft('a'))
    await flush()
    assert.equal(h.hook().draft.text, '')
  } finally {
    h.unmount()
  }
})

test('AN ATTACHMENT IS PART OF THE DRAFT, NOT SEPARATE FROM IT', async () => {
  const attachment: PromptAttachment = {
    id: 'a1',
    kind: 'image',
    name: 'shot.png',
    mimeType: 'image/png',
    data: 'AAAA'
  }
  const h = await mountDrafts('a')
  try {
    await act(async () => h.hook().setDraft({ text: '', attachments: [attachment] }))
    await flush()
    await h.setSession('b')
    assert.deepEqual(h.hook().draft.attachments, [], "A's attachment appeared under B")
    await h.setSession('a')
    assert.deepEqual(
      h.hook().draft.attachments.map((a) => a.name),
      ['shot.png'],
      'a pasted image was dropped on the way back'
    )
  } finally {
    h.unmount()
  }
})

// ── The window where the session gets its name ──────────────────────────────

test('THE DRAFT IS THERE ON THE FIRST RENDER AFTER THE SESSION IS NAMED', async () => {
  // The filing happens in an effect, a render later than the id. The composer swaps
  // its box over on the render where the conversation changes, so if the draft were
  // not already reachable on THAT render it would swap to empty and never look
  // again — the key has changed, so nothing re-syncs. The message would vanish at
  // the moment the agent finished booting.
  //
  // Every render is recorded, because "it is right once things settle" is exactly
  // what a per-render check has to disprove.
  const seen: { key: string; text: string }[] = []
  let write: ((d: Draft) => void) | null = null
  function Probe({ id }: { id: string | null }) {
    const d = useDrafts(id)
    write = d.setDraft
    seen.push({ key: d.draftKey, text: d.draft.text })
    return null
  }

  const view = await mount(createElement(Probe, { id: null }))
  await flush()
  await act(async () => write!(draftOf('typed while it opened')))
  await flush()

  seen.length = 0
  await view.rerender(createElement(Probe, { id: 'booted' }))
  await flush()
  view.unmount()

  assert.ok(seen.length > 0, 'nothing rendered after the naming')
  assert.deepEqual(
    seen[0],
    { key: 'booted', text: 'typed while it opened' },
    'the first render after the naming did not carry the draft'
  )
  assert.ok(
    seen.every((s) => s.text === 'typed while it opened'),
    'the draft flickered away on a later render'
  )
})

test('A MESSAGE WRITTEN FOR A CONVERSATION IS NOT OVERWRITTEN BY ONE WRITTEN WITHOUT ONE', async () => {
  // Both can exist: restarting the agent drops the session id, and typing is still
  // allowed. When the conversation comes back it already has a draft of its own.
  // The one written FOR it wins — a decision, not an accident. Preferring the newer
  // unnamed text would silently destroy something written deliberately for that
  // conversation, and the unnamed one is discarded either way.
  let write: ((d: Draft) => void) | null = null
  const captured: string[] = []
  function Watch({ id }: { id: string | null }) {
    const d = useDrafts(id)
    write = d.setDraft
    captured.push(d.draft.text)
    return null
  }

  const view = await mount(createElement(Watch, { id: 'a' }))
  await flush()
  await act(async () => write!(draftOf('written for A')))
  await flush()

  // The agent restarts: no session, and something else gets typed.
  await view.rerender(createElement(Watch, { id: null }))
  await flush()
  await act(async () => write!(draftOf('typed with nothing open')))
  await flush()

  captured.length = 0
  await view.rerender(createElement(Watch, { id: 'a' }))
  await flush()
  view.unmount()

  assert.equal(captured[captured.length - 1], 'written for A')
})

test('AN UNTOUCHED COMPOSER DOES NOT WRITE ANYTHING BACK', async () => {
  // It used to hand its empty box back on a timer: pointless work every time
  // anyone opened a conversation, and it erased a draft written by anything else,
  // which is how a test of this file first came to pass for the wrong reason.
  const handed: Draft[] = []
  const view = await mount(
    createElement(
      Composer,
      props({ draft: draftOf('handed down'), onDraftChange: (d: Draft) => handed.push(d) })
    )
  )
  try {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    assert.deepEqual(handed, [], 'the composer wrote back without being touched')
  } finally {
    view.unmount()
  }
})

// ── Typed for real, end to end ─────────────────────────────────────────────

/** The composer wired to the hook, the way App wires them. */
function Pair({ id }: { id: string | null }) {
  const { draft, draftKey, setDraft, clearDraft } = useDrafts(id)
  return createElement(
    Composer,
    props({ draft, draftKey, onDraftChange: setDraft, onDraftSent: clearDraft })
  )
}

test('TEXT TYPED AND NOT SENT SURVIVES LEAVING THE CONVERSATION', async () => {
  // The claim #71 is actually about, and the one that could only be argued from
  // reading while the composer was on onChange.
  const handed: Draft[] = []
  const view = await mount(
    createElement(Composer, props({ onDraftChange: (d: Draft) => handed.push(d) }))
  )
  await type(box(view), 'half a thought I am not finished with')
  assert.equal(box(view).value, 'half a thought I am not finished with', 'React never saw it')

  view.unmount()
  await flush()

  assert.equal(
    handed[handed.length - 1]?.text,
    'half a thought I am not finished with',
    'leaving threw away what was typed'
  )
})

test('TYPING FOR ONE CONVERSATION DOES NOT FOLLOW YOU TO ANOTHER', async () => {
  const view = await mount(createElement(Pair, { id: 'a' }))
  await flush()
  try {
    await type(box(view), 'meant for A')
    assert.equal(box(view).value, 'meant for A')

    await view.rerender(createElement(Pair, { id: 'b' }))
    await flush()
    assert.equal(box(view).value, '', "A's message was sitting in B's box")

    await view.rerender(createElement(Pair, { id: 'a' }))
    await flush()
    assert.equal(box(view).value, 'meant for A', 'coming back lost it')
  } finally {
    view.unmount()
  }
})

test('TEXT TYPED WHILE A SESSION IS STILL BOOTING SURVIVES IT BEING NAMED', async () => {
  // Typed with no session, then the agent answers and the conversation has an id.
  // Driven through the composer this time, so it covers the swap as well as the hook.
  const view = await mount(createElement(Pair, { id: null }))
  await flush()
  try {
    await type(box(view), 'typed while it opened')
    await view.rerender(createElement(Pair, { id: 'booted' }))
    await flush()
    assert.equal(box(view).value, 'typed while it opened')
  } finally {
    view.unmount()
  }
})
