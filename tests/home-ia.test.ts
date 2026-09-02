import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { flush, mount } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'
import { HomeView } from '../src/components/HomeView'
import { ProjectHome } from '../src/components/ProjectHome'
import { ChatHome } from '../src/components/ChatHome'
import type { ActivityCalendarState } from '../src/hooks/useActivityCalendar'
import type { ProjectContext, SessionInfo } from '../shared/types'

/**
 * Home used to list folders and Build sessions — the same catalog Build already
 * owns. That made three places to pick the same work. These tests fail if Home
 * grows those lists back, and they fail if the catalogs vanish from Chat/Build
 * instead of moving.
 */

const idleCalendar: ActivityCalendarState = {
  calendar: {
    days: [],
    from: '2026-01-01',
    to: '2026-01-01',
    peak: 1,
    totalUserTurns: 0,
    currentStreak: 0,
    longestStreak: 0
  },
  loading: false,
  error: null,
  refresh: async () => {}
}

const projects: ProjectContext[] = [
  { cwd: '/work/alpha', name: 'alpha' },
  { cwd: '/work/beta', name: 'beta' }
]

const buildSessions: SessionInfo[] = [
  {
    id: 'a1',
    cwd: '/work/alpha',
    title: 'Rate limiter',
    createdAt: 1,
    updatedAt: 8_000,
    surface: 'project'
  },
  {
    id: 'b1',
    cwd: '/work/beta',
    title: 'Dashboard',
    createdAt: 1,
    updatedAt: 4_000,
    surface: 'project'
  }
]

const chatSessions: SessionInfo[] = [
  {
    id: 'c1',
    cwd: '/data/chat-workspace',
    title: 'Mutex vs semaphore',
    createdAt: 1,
    updatedAt: 9_000,
    surface: 'chat'
  }
]

test('Home is a landing pad: Chat and Build, no folder or session catalog', async () => {
  const bridge = installFakeBridge()
  const opened: string[] = []
  const view = await mount(
    createElement(HomeView, {
      authenticated: true,
      grokFound: true,
      activityCalendar: idleCalendar,
      onOpenChat: () => opened.push('chat'),
      onOpenProjects: () => opened.push('build'),
      onSignIn: () => {},
      onSettings: () => {}
    })
  )
  await flush()
  try {
    const text = view.text()
    assert.match(text, /Chat/)
    assert.match(text, /Build/)
    assert.doesNotMatch(text, /Folders/)
    assert.doesNotMatch(text, /Workspaces/)
    assert.doesNotMatch(text, /Build sessions/)
    assert.doesNotMatch(text, /Rate limiter/)
    assert.doesNotMatch(text, /alpha/)
    assert.equal(view.query('.browse-grid'), null, 'Home grew a catalog grid')
    assert.equal(view.query('.workspace-folder-list'), null)
    assert.ok(view.query('.calendar-panel'), 'heatmap left Home')

    const chatBtn = [...view.queryAll('button')].find((b) => b.textContent?.trim() === 'Chat')
    const buildBtn = [...view.queryAll('button')].find((b) => b.textContent?.trim() === 'Build')
    assert.ok(chatBtn && buildBtn)
    await view.click(chatBtn)
    await view.click(buildBtn)
    assert.deepEqual(opened, ['chat', 'build'])
  } finally {
    view.unmount()
    bridge.restore()
  }
})

test('Build still owns folder work, grouped, and Chat still owns chat history', async () => {
  const bridge = installFakeBridge()
  const build = await mount(
    createElement(ProjectHome, {
      projects,
      sessions: buildSessions,
      activeCwd: null,
      activeSessionId: null,
      authenticated: true,
      onOpenFolder: () => {},
      onOpenProject: () => {},
      onNewSession: () => {},
      onSelectSession: () => {},
      onRename: () => {},
      onArchive: () => {},
      onExport: () => {},
      onDelete: () => {},
      onSignIn: () => {}
    })
  )
  await flush()
  const chat = await mount(
    createElement(ChatHome, {
      sessions: chatSessions,
      activeSessionId: null,
      authenticated: true,
      onNewChat: () => {},
      onSelectSession: () => {},
      onRename: () => {},
      onArchive: () => {},
      onDelete: () => {},
      onSignIn: () => {}
    })
  )
  await flush()
  try {
    const buildText = build.text()
    assert.match(buildText, /alpha/)
    assert.match(buildText, /Rate limiter/)
    assert.match(buildText, /beta/)
    assert.match(buildText, /Dashboard/)
    const blocks = [...build.container.querySelectorAll('.workspace-folder-block')]
    assert.ok(blocks.length >= 2, 'Build no longer groups sessions under folders')
    const alpha = blocks.find((el) =>
      el.querySelector('.workspace-folder-name')?.textContent?.includes('alpha')
    )
    assert.ok(alpha)
    assert.match(alpha.textContent || '', /Rate limiter/)
    assert.doesNotMatch(alpha.textContent || '', /Dashboard/)
    assert.doesNotMatch(buildText, /Mutex vs semaphore/)

    const chatText = chat.text()
    assert.match(chatText, /Mutex vs semaphore/)
    assert.doesNotMatch(chatText, /Rate limiter/)
  } finally {
    chat.unmount()
    build.unmount()
    bridge.restore()
  }
})
