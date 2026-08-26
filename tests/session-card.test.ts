import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { ensureDom, flush, mount } from './helpers/render'
import { SessionCard } from '../src/components/SessionCard'
import type { SessionInfo } from '../shared/types'

/**
 * The browse card's actions: the menu is the shared MenuButton, delete asks first,
 * rename commits only a real change.
 */

const session = (over: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    id: 'sess-1234',
    cwd: '/work/alpha',
    title: 'Rate limiter drops bursts under load',
    createdAt: 1,
    updatedAt: 1,
    surface: 'project',
    ...over
  }) as SessionInfo

interface Callbacks {
  onSelect?: () => void
  onRename?: (t: string) => void
  onArchive?: () => void
  onUnarchive?: () => void
  onExport?: (f: 'md' | 'json') => void
  onDelete?: () => void
}

async function card(s: SessionInfo, cb: Callbacks = {}) {
  const view = await mount(
    createElement(SessionCard, {
      session: s,
      onSelect: cb.onSelect ?? (() => {}),
      onRename: cb.onRename ?? (() => {}),
      onArchive: cb.onArchive,
      onUnarchive: cb.onUnarchive,
      onExport: cb.onExport,
      onDelete: cb.onDelete ?? (() => {})
    } as never)
  )
  await flush()
  return view
}

async function openMenu(view: Awaited<ReturnType<typeof card>>) {
  const trigger = view.query('.menu-btn.icon')
  assert.ok(trigger, 'the card has no menu trigger')
  await view.click(trigger)
  await flush()
  return [...document.querySelectorAll('.menu-pop-item')] as HTMLButtonElement[]
}

const itemNamed = (items: HTMLButtonElement[], name: string) =>
  items.find((b) => b.querySelector('.menu-pop-name')?.textContent?.trim() === name)

test('THE CARD MENU IS THE SHARED ONE, WITH THE ACTIONS THE PROPS ALLOW', async () => {
  const view = await card(session(), { onArchive: () => {}, onExport: () => {} })
  try {
    const items = await openMenu(view)
    const names = items.map((b) => b.querySelector('.menu-pop-name')?.textContent?.trim())
    // Export is two flat items, matching the sidebar — the submenu died with the
    // hand-rolled menu.
    assert.deepEqual(names, [
      'Rename',
      'Export as Markdown',
      'Export as JSON',
      'Archive',
      'Delete'
    ])
  } finally {
    view.unmount()
  }
})

test('OPTIONAL ACTIONS ARE ABSENT, NOT DISABLED', async () => {
  // The archived list omits Archive and Export; a permanently greyed item reads as
  // something broken.
  const view = await card(session({ archived: true }), { onUnarchive: () => {} })
  try {
    const items = await openMenu(view)
    const names = items.map((b) => b.querySelector('.menu-pop-name')?.textContent?.trim())
    assert.deepEqual(names, ['Rename', 'Restore', 'Delete'])
  } finally {
    view.unmount()
  }
})

test('EXPORT FIRES WITH THE FORMAT THE ITEM NAMES', async () => {
  const formats: string[] = []
  const view = await card(session(), { onExport: (f) => formats.push(f) })
  try {
    let items = await openMenu(view)
    await view.click(itemNamed(items, 'Export as Markdown')!)
    await flush()
    items = await openMenu(view)
    await view.click(itemNamed(items, 'Export as JSON')!)
    await flush()
    assert.deepEqual(formats, ['md', 'json'])
  } finally {
    view.unmount()
  }
})

test('DELETE ASKS IN THE CARD AND NOTHING IS DELETED UNTIL CONFIRMED', async () => {
  // Delete alone destroys nothing, and Cancel really cancels.
  let deleted = 0
  const view = await card(session(), { onDelete: () => deleted++ })
  try {
    let items = await openMenu(view)
    await view.click(itemNamed(items, 'Delete')!)
    await flush()
    assert.equal(deleted, 0, 'clicking Delete in the menu deleted immediately')
    assert.ok(
      document.querySelector('.session-confirm-text')?.textContent?.includes('Delete'),
      'no confirmation appeared'
    )

    const cancel = [...document.querySelectorAll('.session-confirm-actions .btn-mini')].find(
      (b) => b.textContent?.trim() === 'Cancel'
    )
    await view.click(cancel!)
    await flush()
    assert.equal(deleted, 0, 'Cancel deleted anyway')
    assert.ok(!document.querySelector('.session-confirm-text'), 'the confirm state stuck')

    items = await openMenu(view)
    await view.click(itemNamed(items, 'Delete')!)
    await flush()
    const confirm = [...document.querySelectorAll('.session-confirm-actions .btn-mini')].find(
      (b) => b.textContent?.trim() === 'Delete'
    )
    await view.click(confirm!)
    await flush()
    assert.equal(deleted, 1)
  } finally {
    view.unmount()
  }
})

/** Type into the rename input the way a person does (prototype setter + input event). */
async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  const win = ensureDom().window
  // React 19 watches focused text inputs through an IE-era polyfill whose teardown
  // calls detachEvent, which jsdom lacks — the first focus shift after typing throws.
  // No-op stubs for an API nothing real runs anymore.
  const proto = win.HTMLElement.prototype as unknown as Record<string, unknown>
  proto.attachEvent ??= () => {}
  proto.detachEvent ??= () => {}
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter, 'jsdom has no input value setter')
  // Inside act, like type() in session-drafts.test.ts: without it the state update
  // from the input event has not landed when the next keydown reads it.
  await act(async () => {
    setter.call(input, text)
    input.dispatchEvent(new win.Event('input', { bubbles: true }))
  })
  await flush()
}

const key = async (el: Element, k: string): Promise<void> => {
  const win = ensureDom().window
  await act(async () => {
    el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
  await flush()
}

test('RENAME COMMITS A CHANGED TITLE AND ONLY A CHANGED ONE', async () => {
  // The guard under test: `if (t && t !== session.title) onRename(t)`. Escape routes
  // around commitRename, so only the Enter path exercises it.
  const renames: string[] = []
  const view = await card(session(), { onRename: (t) => renames.push(t) })
  try {
    // Changed title, Enter: commits.
    let items = await openMenu(view)
    await view.click(itemNamed(items, 'Rename')!)
    await flush()
    let input = document.querySelector('.browse-rename') as HTMLInputElement
    await typeInto(input, 'A better name')
    await key(input, 'Enter')
    await flush()
    assert.deepEqual(renames, ['A better name'])
    assert.ok(!document.querySelector('.browse-rename'), 'the input stayed open after commit')

    // Unchanged title, Enter: a cancel, not a rename to the same words.
    items = await openMenu(view)
    await view.click(itemNamed(items, 'Rename')!)
    await flush()
    input = document.querySelector('.browse-rename') as HTMLInputElement
    await key(input, 'Enter')
    await flush()

    // Emptied title, Enter: also a cancel — never a rename to "".
    items = await openMenu(view)
    await view.click(itemNamed(items, 'Rename')!)
    await flush()
    input = document.querySelector('.browse-rename') as HTMLInputElement
    await typeInto(input, '   ')
    await key(input, 'Enter')
    await flush()

    assert.deepEqual(renames, ['A better name'], 'an unchanged or empty title fired a rename')
  } finally {
    view.unmount()
  }
})

test('ESCAPE CLOSES THE RENAME INPUT WITHOUT COMMITTING', async () => {
  const renames: string[] = []
  const view = await card(session(), { onRename: (t) => renames.push(t) })
  try {
    const items = await openMenu(view)
    await view.click(itemNamed(items, 'Rename')!)
    await flush()
    const input = document.querySelector('.browse-rename') as HTMLInputElement
    await typeInto(input, 'Discarded words')
    await key(input, 'Escape')
    await flush()
    // Both halves, or the assertion is vacuous against a component that ignores
    // Escape entirely: the input is gone AND nothing was committed.
    assert.ok(!document.querySelector('.browse-rename'), 'Escape did not close the input')
    assert.deepEqual(renames, [])
  } finally {
    view.unmount()
  }
})

test('NO NATIVE DIALOG REMAINS ANYWHERE IN THE RENDERER', async () => {
  // window.confirm blocks the entire app process in Electron. The card was the last
  // caller; this keeps the next one out of src/ entirely.
  const { readFileSync, readdirSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const hits: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(name) && /\bwindow\.confirm\(|(?<![.\w])confirm\(/.test(readFileSync(p, 'utf8'))) {
        hits.push(p)
      }
    }
  }
  walk(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  assert.deepEqual(hits, [], 'a native confirm() dialog is back in the renderer')
})
