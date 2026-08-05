import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement, Fragment } from 'react'
import { flush, mount } from './helpers/render'
import { Sidebar } from '../src/components/Sidebar'
import { ActivityCalendar } from '../src/components/ActivityCalendar'
import type { ActivityCalendar as Calendar, AppSurface, DayActivity } from '../shared/types'

/**
 * The sidebar's two modes, and the words the screenshot harness clicks.
 *
 * `scripts/visual/capture.js` drives the app by text: `clickText: 'Build'` and
 * `clickText: 'Chat'` appear in scenarios including the readme-* shots that
 * produce the published screenshots. Its resolver is reproduced below rather
 * than described, because "the nav is still what those steps hit" is the kind of
 * claim that is easy to assert loosely and be wrong about. The harness itself
 * cannot run here.
 */

/**
 * The build label and version are Vite defines, absent under node --test.
 * Set before the first render rather than mocked: the footer reads it during
 * render and would throw, which looks like a nav bug and is not one.
 */
;(globalThis as unknown as Record<string, string>).__APP_VERSION__ = '0.0.0-test'
;(globalThis as unknown as Record<string, string>).__APP_BUILD_LABEL__ = 'test'

const noop = () => {}

const BASE = {
  authenticated: true,
  surface: 'home' as AppSurface,
  projects: [],
  projectSessions: [],
  chatSessions: [],
  chatWorkspacePath: '/data/chat-workspace',
  activeCwd: null,
  activeSessionId: null,
  archivedCount: 0,
  onGoHome: noop,
  onGoChat: noop,
  onGoProjects: noop,
  onOpenProject: noop,
  onOpenChat: noop,
  onSelectSession: noop,
  onRenameSession: noop,
  onArchiveSession: noop,
  onExportSession: noop,
  onDeleteSession: noop,
  onRemoveProject: noop,
  onPinProject: noop,
  onOpenPlugins: noop,
  onNewProjectSession: noop,
  onOpenArchived: noop,
  onOpenSettings: noop,
  onSignIn: noop
}

function sidebar(over: Record<string, unknown> = {}) {
  return createElement(Sidebar, { ...BASE, ...over } as never)
}

function day(date: string, chat: number, build: number): DayActivity {
  return {
    date,
    userTurns: chat + build,
    messages: chat + build,
    sessions: (chat > 0 ? 1 : 0) + (build > 0 ? 1 : 0),
    chat: { userTurns: chat, messages: chat, sessions: chat > 0 ? 1 : 0 },
    build: { userTurns: build, messages: build, sessions: build > 0 ? 1 : 0 }
  }
}

const CALENDAR: Calendar = {
  days: [day('2025-07-14', 2, 3), day('2025-07-15', 0, 1)],
  from: '2025-07-14',
  to: '2025-07-15',
  peak: 5,
  totalUserTurns: 6,
  currentStreak: 2,
  longestStreak: 2
}

/**
 * `capture.js` verbatim: every button, anchor and role=button in document order,
 * first one whose trimmed lowercase text CONTAINS the wanted string.
 */
function harnessResolve(container: HTMLElement, wanted: string): Element | undefined {
  const els = Array.from(container.querySelectorAll('button, [role=button], a'))
  return els.find((e) => (e.textContent || '').trim().toLowerCase().includes(wanted.toLowerCase()))
}

/** Sidebar then main, which is the order App renders them in. */
function homeScreen(over: Record<string, unknown> = {}) {
  return createElement(
    Fragment,
    null,
    sidebar(over),
    createElement(ActivityCalendar, {
      state: { calendar: CALENDAR, loading: false, error: null, refresh: async () => {} }
    })
  )
}

test('Home is no longer a nav item', async () => {
  const view = await mount(sidebar())
  await flush()
  const items = view.queryAll('.nav-item')
  assert.equal(items.length, 2)
  assert.deepEqual(
    items.map((el) => el.querySelector('.nav-item-label')?.textContent),
    ['Chat', 'Build']
  )
  view.unmount()
})

test('THE RULE IS ON THE CONTROL: each mode says whether it gets a folder', async () => {
  // This is the app's whole safety distinction, and it used to live only in
  // prose on a screen you had to go looking for.
  const view = await mount(sidebar())
  await flush()
  const subs = view.queryAll('.nav-item-sub').map((el) => el.textContent)
  assert.deepEqual(subs, ['no project folder', 'a folder on your computer'])
  view.unmount()
})

test('the mark is the way to Home', async () => {
  let went = 0
  const view = await mount(sidebar({ onGoHome: () => (went += 1) }))
  await flush()
  const brand = view.query('.brand')
  assert.ok(brand, 'no brand control')
  assert.equal(brand.tagName, 'BUTTON', 'the mark has to be a real button, not a click handler')
  await view.click(brand)
  assert.equal(went, 1)
  view.unmount()
})

test('the mark says where you are without dressing as a nav peer', async () => {
  const home = await mount(sidebar({ surface: 'home' }))
  await flush()
  assert.equal(home.query('.brand')?.getAttribute('aria-current'), 'page')
  // No `active` class: that indicator belongs to the two modes.
  assert.equal(home.query('.brand')?.className.includes('active'), false)
  home.unmount()

  const chat = await mount(sidebar({ surface: 'chat' }))
  await flush()
  assert.equal(chat.query('.brand')?.getAttribute('aria-current'), null)
  chat.unmount()
})

test('the open mode is the one marked selected', async () => {
  for (const [surface, label] of [
    ['chat', 'Chat'],
    ['project', 'Build']
  ] as const) {
    const view = await mount(sidebar({ surface }))
    await flush()
    const active = view.queryAll('.nav-item.active')
    assert.equal(active.length, 1, `${surface} marked ${active.length} items`)
    assert.equal(active[0].querySelector('.nav-item-label')?.textContent, label)
    view.unmount()
  }

  // Home selects neither, which is the point: it is not one of them.
  const home = await mount(sidebar({ surface: 'home' }))
  await flush()
  assert.equal(home.queryAll('.nav-item.active').length, 0)
  home.unmount()
})

test('THE HARNESS STILL LANDS ON THE NAV, not on the calendar filter', async () => {
  // The scope filter offers All / Chat / Build, so the words now appear twice on
  // Home. The resolver takes the first match in document order and the sidebar
  // is rendered before <main>, so the nav wins, but only while that stays true.
  const view = await mount(homeScreen())
  await flush()

  // Both are genuinely on the page, or this test would prove nothing.
  assert.ok(view.query('.calendar-scope-btn'), 'no scope filter rendered')

  for (const word of ['Chat', 'Build']) {
    const hit = harnessResolve(view.container, word)
    assert.ok(hit, `nothing matched ${word}`)
    assert.ok(
      hit.classList.contains('nav-item'),
      `${word} resolved to .${[...hit.classList].join('.') || hit.tagName} instead of the nav item`
    )
  }
  view.unmount()
})

test('the subtitle does not break the text match the harness makes', async () => {
  // clickText is a contains match, so "Chat" has to still be found inside
  // "Chatno project folder" once the two spans are concatenated.
  const view = await mount(sidebar())
  await flush()
  for (const word of ['chat', 'build']) {
    const nav = view
      .queryAll('.nav-item')
      .filter((el) => (el.textContent || '').toLowerCase().includes(word))
    assert.equal(nav.length, 1, `${word} matched ${nav.length} nav items`)
  }
  view.unmount()
})

test('the scope filter is a filter, not a second chart', async () => {
  const view = await mount(
    createElement(ActivityCalendar, {
      state: { calendar: CALENDAR, loading: false, error: null, refresh: async () => {} }
    })
  )
  await flush()
  assert.equal(view.queryAll('.calendar-grid').length, 1)

  const chat = view.queryAll('.calendar-scope-btn').find((b) => b.textContent === 'Chat')
  assert.ok(chat, 'no Chat scope button')
  await view.click(chat)
  assert.equal(view.queryAll('.calendar-grid').length, 1, 'a second chart appeared')
  assert.equal(chat.getAttribute('aria-pressed'), 'true')
  // 2 of the 6 prompts are Chat, and the streak line goes with the filter.
  assert.match(view.text(), /2 prompts/)
  assert.equal(view.text().includes('streak'), false)
  view.unmount()
})
