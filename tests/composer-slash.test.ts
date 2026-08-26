import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { ensureDom, flush, mount } from './helpers/render'
import { Composer } from '../src/components/Composer'
import { EMPTY_DRAFT } from '../src/hooks/useDrafts'
import type { AgentCommand } from '../shared/types'

/**
 * Slash-command completion in the composer.
 *
 * The list is the agent's own (`availableCommands`), so the menu shows only what this
 * session accepts. Completion must never hijack a normal send: the menu is open only
 * while the draft is a single half-typed command token, and once an argument or a
 * trailing space follows, Enter sends as it always did.
 */

const COMMANDS: AgentCommand[] = [
  { name: 'compact', description: 'Compress conversation history', hint: 'what to keep' },
  { name: 'context', description: 'Show context window usage' },
  { name: 'goal', description: 'Set or check a goal' }
]

const props = (over: Record<string, unknown> = {}) =>
  ({
    hydrating: false,
    busy: false,
    connection: 'ready',
    authenticated: true,
    cwd: '/work/alpha',
    surface: 'project',
    permissionMode: 'default',
    onSend: () => {},
    onCancel: () => {},
    draft: EMPTY_DRAFT,
    draftKey: 's1',
    onDraftChange: () => {},
    onDraftSent: () => {},
    onQueue: () => {},
    queued: [],
    queueHeld: false,
    onRemoveQueued: () => {},
    commands: COMMANDS,
    ...over
  }) as never

async function composer(over: Record<string, unknown> = {}) {
  const view = await mount(createElement(Composer, props(over)))
  await flush()
  const box = document.querySelector('.composer-wrap textarea') as HTMLTextAreaElement | null
  assert.ok(box, 'no composer textarea')
  return { view, box }
}

async function type(box: HTMLTextAreaElement, value: string): Promise<void> {
  const win = ensureDom().window
  // React 19 routes keydown through an IE-era input polyfill whose focus tracking
  // crashes on a field React never saw receive focus, and whose teardown calls
  // detachEvent, which jsdom lacks. Focus through the DOM first and stub the dead API.
  const proto = win.HTMLElement.prototype as unknown as Record<string, unknown>
  proto.attachEvent ??= () => {}
  proto.detachEvent ??= () => {}
  if (document.activeElement !== box) {
    await act(async () => {
      box.focus()
    })
  }
  const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')?.set
  assert.ok(setter, 'jsdom has no textarea value setter')
  await act(async () => {
    setter.call(box, value)
    box.dispatchEvent(new win.Event('input', { bubbles: true }))
  })
  await flush()
}

async function key(box: HTMLTextAreaElement, k: string): Promise<void> {
  const win = ensureDom().window
  await act(async () => {
    box.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
  await flush()
}

const menuNames = () =>
  [...document.querySelectorAll('[aria-label="Commands"] .mention-name')].map((e) =>
    e.textContent?.trim()
  )

test('TYPING A SLASH OFFERS THE AGENT’S OWN COMMANDS, FILTERED AS YOU TYPE', async () => {
  const { view, box } = await composer()
  try {
    await type(box, '/')
    assert.deepEqual(menuNames(), ['/compact', '/context', '/goal'])

    await type(box, '/co')
    assert.deepEqual(menuNames(), ['/compact', '/context'])

    await type(box, '/goa')
    assert.deepEqual(menuNames(), ['/goal'])

    await type(box, '/nope')
    assert.deepEqual(menuNames(), [], 'a prefix nothing matches kept a menu open')
  } finally {
    view.unmount()
  }
})

test('ENTER COMPLETES INSTEAD OF SENDING, AND THE NEXT ENTER SENDS', async () => {
  const sent: string[] = []
  const { view, box } = await composer({ onSend: (t: string) => sent.push(t) })
  try {
    await type(box, '/co')
    await key(box, 'ArrowDown')
    await key(box, 'Enter')
    assert.deepEqual(sent, [], 'Enter sent the half-typed command instead of completing it')
    assert.equal(box.value, '/context ', 'the selected command was not completed')
    assert.deepEqual(menuNames(), [], 'the menu stayed open after completion')

    await key(box, 'Enter')
    assert.deepEqual(sent, ['/context '], 'the send after completion did not go through')
  } finally {
    view.unmount()
  }
})

test('AN ARGUMENT ENDS COMPLETION: ENTER SENDS THE FULL COMMAND LINE', async () => {
  const sent: string[] = []
  const { view, box } = await composer({ onSend: (t: string) => sent.push(t) })
  try {
    await type(box, '/compact keep the model discussion')
    assert.deepEqual(menuNames(), [], 'the menu is open while an argument is being typed')
    await key(box, 'Enter')
    assert.deepEqual(sent, ['/compact keep the model discussion'])
  } finally {
    view.unmount()
  }
})

test('ESCAPE DISMISSES, AND TYPING BRINGS IT BACK', async () => {
  const sent: string[] = []
  const { view, box } = await composer({ onSend: (t: string) => sent.push(t) })
  try {
    await type(box, '/co')
    await key(box, 'Escape')
    assert.deepEqual(menuNames(), [], 'Escape left the menu open')

    // Dismissed means dismissed: Enter now sends the raw text.
    await key(box, 'Enter')
    assert.deepEqual(sent, ['/co'])

    await type(box, '/g')
    assert.deepEqual(menuNames(), ['/goal'], 'typing again did not reopen the menu')
  } finally {
    view.unmount()
  }
})

test('WITHOUT A COMMAND LIST THERE IS NO MENU AND SLASH TEXT SENDS AS TYPED', async () => {
  const sent: string[] = []
  const { view, box } = await composer({ commands: [], onSend: (t: string) => sent.push(t) })
  try {
    await type(box, '/compact')
    assert.deepEqual(menuNames(), [])
    await key(box, 'Enter')
    assert.deepEqual(sent, ['/compact'])
  } finally {
    view.unmount()
  }
})
