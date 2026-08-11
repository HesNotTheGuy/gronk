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

// ── #67: one row, one menu ──────────────────────────────────────────────────

/**
 * A session row showing two `⋯` was seen on the nightly and could not be found by
 * reading. What follows does not fix it — nothing here reproduced it. It pins the
 * two things the investigation did establish, so that if the cause is ever one of
 * them, it fails here instead of being seen again months later.
 */

const chat = (id: string) =>
  ({
    id,
    cwd: '/data/chat-workspace',
    title: id,
    createdAt: 0,
    updatedAt: 1,
    surface: 'chat'
  }) as never

test('ONE MENU BUTTON PER SESSION, LIVE OR NOT', async () => {
  // The row that showed two was a live one, so liveness is set here on purpose:
  // the indicator and the Stop entry both arrived with multi-session, and a control
  // added beside the menu rather than inside it would show up as exactly this.
  const view = await mount(
    sidebar({
      surface: 'chat',
      chatSessions: [chat('a'), chat('b')],
      activeSessionId: 'a',
      sessionLiveness: { a: 'working', b: 'blocked' },
      onStopSession: noop
    })
  )
  try {
    const rows = view.queryAll('.session-item-row')
    assert.equal(rows.length, 2, 'a session was rendered more than once')
    for (const row of rows) {
      assert.equal(
        row.querySelectorAll('.menu-btn').length,
        1,
        'a row drew more than one menu button'
      )
    }
    assert.equal(view.queryAll('.menu-btn').length, 2, 'menus outnumber the rows')
  } finally {
    view.unmount()
  }
})

// Not tested here: that searching REPLACES the list rather than adding to it. If it
// added, a session matching the query would appear twice, each copy with its own
// menu, which is the shape of #67. `showChatRail` and `showProjectRails` both carry
// `&& !searching`, so it holds today — but this harness cannot type into the search
// box (React ignores programmatic input here), and a test that renders without
// searching and then asserts one block would pass whatever those clauses said.

// ── Archived belongs with the sessions ──────────────────────────────────────

const archivedRow = (view: { query: (s: string) => Element | null }) =>
  view.query('.session-nav-archived')

test('ARCHIVED SITS WITH THE SESSIONS, NOT IN THE APP FOOTER', async () => {
  // It used to be in the footer between the account chip and Settings, which grouped a
  // list of sessions with plugins and settings and left it floating in an empty column.
  const view = await mount(
    sidebar({ surface: 'chat', chatSessions: [chat('a')], archivedCount: 2 })
  )
  try {
    const row = archivedRow(view)
    assert.ok(row, 'Archived is not with the sessions')
    assert.ok(
      view.query('.session-nav')?.contains(row!),
      'Archived is outside the session list it belongs to'
    )
    assert.ok(!view.query('.sidebar-footer')?.contains(row!), 'Archived is still in the footer')
    assert.match(row!.textContent ?? '', /2/, 'the count went missing')
  } finally {
    view.unmount()
  }
})

test('IT IS THERE ON BOTH SURFACES THAT HAVE A SESSION LIST', async () => {
  for (const surface of ['chat', 'project'] as const) {
    const view = await mount(sidebar({ surface, archivedCount: 1 }))
    try {
      assert.ok(archivedRow(view), `no Archived on the ${surface} surface`)
    } finally {
      view.unmount()
    }
  }
})

test('WITH NOTHING ARCHIVED IT IS NOT OFFERED', async () => {
  const view = await mount(sidebar({ surface: 'chat', archivedCount: 0 }))
  try {
    assert.equal(archivedRow(view), null)
  } finally {
    view.unmount()
  }
})

test('IT IS STILL OFFERED WHEN EVERY SESSION IS ARCHIVED', async () => {
  // The case where it matters most: nothing active to list, so an empty list plus no way
  // to reach the archive would be a dead end.
  const view = await mount(sidebar({ surface: 'chat', chatSessions: [], archivedCount: 3 }))
  try {
    assert.ok(archivedRow(view), 'a user whose only sessions are archived cannot reach them')
  } finally {
    view.unmount()
  }
})

test('OPENING IT ASKS THE APP TO SHOW THE ARCHIVE', async () => {
  let opened = 0
  const view = await mount(
    sidebar({ surface: 'chat', archivedCount: 1, onOpenArchived: () => (opened += 1) })
  )
  try {
    await view.click(archivedRow(view)!)
    assert.equal(opened, 1)
  } finally {
    view.unmount()
  }
})

test('HOME NO LONGER OFFERS IT, WHICH IS THE COST OF THE MOVE', async () => {
  // Written down rather than left as a surprise: Home has no session list, and a session
  // is restored into Chat or Build, both of which show it.
  const view = await mount(sidebar({ surface: 'home', archivedCount: 2 }))
  try {
    assert.equal(archivedRow(view), null)
  } finally {
    view.unmount()
  }
})
