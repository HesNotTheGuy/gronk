import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { ensureDom, flush, mount } from './helpers/render'
import { SessionTray } from '../src/components/SessionTray'
import type { ProjectNotes } from '../shared/types'

/**
 * The wiring around the notes decision, which the pure tests cannot reach.
 *
 * `src/lib/project-notes.ts` answers what is shown and what is worth saving.
 * What is left here is when the answer is asked for, and that half is where the
 * losable behaviour lives: a debounced save that has not fired yet is text the
 * user typed and can still be thrown away. Every case below is one way of
 * leaving the box.
 *
 * The app cannot be launched from an agent seat, so this jsdom mount is the only
 * evidence that any of it runs at all.
 */

const ALPHA = 'C:/work/alpha'
const BETA = 'C:/work/beta'

const NOTES: ProjectNotes = { [ALPHA]: 'ratelimit lives in gateway/limits.ts' }

interface Saved {
  cwd: string
  note: string
}

function tray(
  over: Partial<Parameters<typeof SessionTray>[0]> = {},
  saves: Saved[] = []
) {
  return createElement(SessionTray, {
    showPlan: false,
    sessionId: 's1',
    plan: null,
    messages: [],
    usage: null,
    auth: null,
    notesCwd: ALPHA,
    notes: NOTES,
    onSaveNote: (cwd: string, note: string) => saves.push({ cwd, note }),
    ...over
  })
}

/** Type into the box the way a user does: React only sees a native input event. */
async function type(el: Element, text: string): Promise<void> {
  const window = ensureDom().window
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )?.set
  assert.ok(setter, 'jsdom has no textarea value setter')
  setter.call(el, text)
  el.dispatchEvent(new window.Event('input', { bubbles: true }))
  await flush()
}

async function openNotes(view: Awaited<ReturnType<typeof mount>>): Promise<Element> {
  const tab = view.queryAll('.session-tray-tab').find((b) => b.textContent?.includes('Notes'))
  assert.ok(tab, 'no Notes tab in the rail')
  await view.click(tab)
  const box = view.query('.project-note')
  assert.ok(box, 'opening Notes showed no text box')
  return box
}

test('a project session has a Notes tab even with no plan, agents or usage', async () => {
  // This is a real consequence, not an incidental one: the tray used to render
  // nothing at all in that state, and Notes is the one tab that cannot wait for
  // content to exist, because there would be nowhere to write the first note.
  const view = await mount(tray())
  await flush()
  assert.match(view.text(), /Notes/)
  view.unmount()
})

test('the Chat surface gets no scratchpad, and the tray stays away entirely', async () => {
  const view = await mount(tray({ notesCwd: null }))
  await flush()
  assert.equal(view.text(), '', 'the tray appeared on a surface with nothing to show')
  view.unmount()
})

test('the rail says whether anything is written down, without showing it', async () => {
  // A count rather than a preview: the rail sits above the composer for the whole
  // session and lands in every screenshot taken of it.
  const view = await mount(tray())
  await flush()
  assert.match(view.text(), /4 words/)
  assert.equal(view.text().includes('gateway/limits.ts'), false, 'the rail leaked the note')
  view.unmount()
})

test('THE NOTE IS A TEXTAREA, never rendered markup', async () => {
  // Notes are user-authored text that gets persisted and re-rendered, which is
  // the shape the markdown surface is dangerous for. A textarea's value is not
  // parsed as anything, so there is no rendering decision here to get wrong.
  const view = await mount(tray({ notes: { [ALPHA]: '<img src=x onerror=alert(1)>' } }))
  await flush()
  const box = await openNotes(view)
  assert.equal(box.tagName, 'TEXTAREA')
  assert.equal((box as HTMLTextAreaElement).value, '<img src=x onerror=alert(1)>')
  assert.equal(view.query('img'), null, 'a note produced live DOM')
  view.unmount()
})

test('the stored note is what the box opens with', async () => {
  const view = await mount(tray())
  await flush()
  const box = await openNotes(view)
  assert.equal((box as HTMLTextAreaElement).value, NOTES[ALPHA])
  view.unmount()
})

test('a project with no note opens an empty box rather than the last one seen', async () => {
  const view = await mount(tray({ notesCwd: BETA }))
  await flush()
  const box = await openNotes(view)
  assert.equal((box as HTMLTextAreaElement).value, '')
  view.unmount()
})

test('the box stays disabled until the notes have actually loaded', async () => {
  // Otherwise the first hydrate lands on top of whatever was being typed into an
  // empty-looking box and silently replaces it.
  const view = await mount(tray({ notes: null }))
  await flush()
  const box = await openNotes(view)
  assert.equal((box as HTMLTextAreaElement).disabled, true)
  view.unmount()
})

test('WHAT WAS TYPED IS NOT LOST: closing the session flushes the pending save', async () => {
  const saves: Saved[] = []
  const view = await mount(tray({}, saves))
  await flush()
  const box = await openNotes(view)
  await type(box, 'and check the 429 retry')
  // Deliberately before the debounce fires. Unmounting here is what happens when
  // the session closes, the surface changes, or the tray loses its last tab.
  assert.deepEqual(saves, [], 'a keystroke wrote straight to the store')
  view.unmount()
  assert.deepEqual(saves, [{ cwd: ALPHA, note: 'and check the 429 retry' }])
})

test('LEAVING A PROJECT FILES THE NOTE UNDER THAT PROJECT, not the next one', async () => {
  // The failure this guards is silent and permanent: one project's notes written
  // into another project's key, over whatever was already there. There is one
  // render, between the cwd changing and the box being reloaded, where the old
  // text sits next to the new cwd.
  const saves: Saved[] = []
  const view = await mount(tray({}, saves))
  await flush()
  const box = await openNotes(view)
  await type(box, 'alpha only')
  await view.rerender(tray({ notesCwd: BETA }, saves))
  await flush()
  assert.deepEqual(saves, [{ cwd: ALPHA, note: 'alpha only' }])
})

test('a draft is only ever saved against the project it was loaded for', async () => {
  // Constructed rather than reachable: today the reload always lands in the same
  // commit as the cwd change, so the pairing check is defence against that
  // ordering changing rather than against a bug anyone can currently hit. This
  // is the smallest arrangement in which it does something, so that removing it
  // is a failing test rather than a silent widening.
  const saves: Saved[] = []
  const view = await mount(tray({}, saves))
  await flush()
  const box = await openNotes(view)
  await type(box, 'alpha only')
  // The new project arrives with no notes to reload from, so the box keeps the
  // old text while the cwd beside it has already moved on.
  await view.rerender(tray({ notesCwd: BETA, notes: null }, saves))
  await flush()
  view.unmount()
  assert.deepEqual(saves, [{ cwd: ALPHA, note: 'alpha only' }])
})

test('switching project loads that project\'s note into the box', async () => {
  const saves: Saved[] = []
  const notes: ProjectNotes = { [ALPHA]: 'alpha note', [BETA]: 'beta note' }
  const view = await mount(tray({ notes }, saves))
  await flush()
  const box = await openNotes(view)
  assert.equal((box as HTMLTextAreaElement).value, 'alpha note')
  await view.rerender(tray({ notes, notesCwd: BETA }, saves))
  await flush()
  assert.equal((view.query('.project-note') as HTMLTextAreaElement).value, 'beta note')
  assert.deepEqual(saves, [], 'looking at two projects wrote to the store')
  view.unmount()
})

test('opening the tab and closing it again writes nothing', async () => {
  // Every write re-serializes the whole store file and rolls the backup forward.
  const saves: Saved[] = []
  const view = await mount(tray({}, saves))
  await flush()
  await openNotes(view)
  view.unmount()
  assert.deepEqual(saves, [])
})

test('clearing the box is a save, not a no-op', async () => {
  const saves: Saved[] = []
  const view = await mount(tray({}, saves))
  await flush()
  const box = await openNotes(view)
  await type(box, '')
  view.unmount()
  assert.deepEqual(saves, [{ cwd: ALPHA, note: '' }])
})
