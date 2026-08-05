import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSessionNav,
  compareSessionsByRecency,
  projectLabelForSession,
  sessionNavMeta,
  type SessionNavProject
} from '../src/lib/session-nav'
import type { SessionInfo } from '../shared/types'

const CHAT_WS = '/home/dev/.gronk/chat-workspace'

function session(
  partial: Partial<SessionInfo> & Pick<SessionInfo, 'id' | 'cwd' | 'updatedAt'>
): SessionInfo {
  return {
    createdAt: partial.updatedAt - 1000,
    title: partial.title ?? partial.id,
    surface: partial.surface,
    messageCount: partial.messageCount,
    userTurns: partial.userTurns,
    archived: partial.archived,
    ...partial
  }
}

const projects: SessionNavProject[] = [
  { cwd: '/home/dev/projects/orbital-api', name: 'orbital-api', pinned: true },
  { cwd: '/home/dev/projects/flux-dashboard', name: 'flux-dashboard' }
]

test('recency comparator puts the newest session first', () => {
  const a = session({ id: 'a', cwd: '/a', updatedAt: 100 })
  const b = session({ id: 'b', cwd: '/b', updatedAt: 300 })
  const c = session({ id: 'c', cwd: '/c', updatedAt: 200 })
  assert.ok(compareSessionsByRecency(b, a) < 0, 'b is newer than a')
  assert.ok(compareSessionsByRecency(a, b) > 0)
  assert.deepEqual(
    [a, b, c].sort(compareSessionsByRecency).map((s) => s.id),
    ['b', 'c', 'a']
  )
})

test('recent mode is flat and ordered by updatedAt descending', () => {
  const sessions = [
    session({
      id: 'old',
      cwd: '/home/dev/projects/orbital-api',
      updatedAt: 1_000,
      title: 'Old work'
    }),
    session({
      id: 'new',
      cwd: '/home/dev/projects/flux-dashboard',
      updatedAt: 9_000,
      title: 'New work'
    }),
    session({
      id: 'mid',
      cwd: '/home/dev/projects/orbital-api',
      updatedAt: 5_000,
      title: 'Mid work'
    })
  ]
  const view = buildSessionNav({
    sessions,
    projects,
    mode: 'recent',
    chatWorkspacePath: CHAT_WS
  })
  assert.equal(view.mode, 'recent')
  if (view.mode !== 'recent') return
  assert.deepEqual(
    view.entries.map((e) => e.session.id),
    ['new', 'mid', 'old']
  )
  assert.equal(view.entries[0].projectLabel, 'flux-dashboard')
  assert.equal(view.entries[1].projectLabel, 'orbital-api')
  assert.equal(view.hidden, 0)
})

test('by-project groups sessions under their cwd, newest group first', () => {
  const sessions = [
    session({
      id: 'o1',
      cwd: '/home/dev/projects/orbital-api',
      updatedAt: 1_000,
      title: 'DEV SEAT'
    }),
    session({
      id: 'f1',
      cwd: '/home/dev/projects/flux-dashboard',
      updatedAt: 9_000,
      title: 'DEV SEAT'
    }),
    session({
      id: 'o2',
      cwd: '/home/dev/projects/orbital-api',
      updatedAt: 8_000,
      title: 'Other'
    })
  ]
  const view = buildSessionNav({
    sessions,
    projects,
    mode: 'by-project',
    chatWorkspacePath: CHAT_WS
  })
  assert.equal(view.mode, 'by-project')
  if (view.mode !== 'by-project') return
  // orbital is pinned, so it ranks above flux even though flux has a newer session.
  assert.equal(view.groups[0].projectLabel, 'orbital-api')
  assert.deepEqual(
    view.groups[0].entries.map((e) => e.session.id),
    ['o2', 'o1']
  )
  assert.equal(view.groups[1].projectLabel, 'flux-dashboard')
  assert.deepEqual(
    view.groups[1].entries.map((e) => e.session.id),
    ['f1']
  )
})

test('a session whose project left the recent list still gets a folder label', () => {
  const orphan = session({
    id: 'gone',
    cwd: '/home/dev/projects/packet-relay',
    updatedAt: 5_000,
    title: 'Orphan work'
  })
  assert.equal(
    projectLabelForSession(orphan, projects, CHAT_WS),
    'packet-relay',
    'folder name when the project is no longer in recentProjects'
  )
  const view = buildSessionNav({
    sessions: [orphan],
    projects,
    mode: 'recent',
    chatWorkspacePath: CHAT_WS
  })
  assert.equal(view.mode, 'recent')
  if (view.mode !== 'recent') return
  assert.equal(view.entries[0].projectLabel, 'packet-relay')
})

test('chat and project surfaces mixed: Chat label, not a sandbox folder name', () => {
  const sessions = [
    session({
      id: 'c1',
      cwd: CHAT_WS,
      updatedAt: 9_000,
      title: 'Mutex vs semaphore',
      surface: 'chat'
    }),
    session({
      id: 'p1',
      cwd: '/home/dev/projects/orbital-api',
      updatedAt: 8_000,
      title: 'Rate limiter',
      surface: 'project'
    })
  ]
  const view = buildSessionNav({
    sessions,
    projects,
    mode: 'recent',
    chatWorkspacePath: CHAT_WS
  })
  assert.equal(view.mode, 'recent')
  if (view.mode !== 'recent') return
  assert.equal(view.entries[0].projectLabel, 'Chat')
  assert.equal(view.entries[1].projectLabel, 'orbital-api')
  assert.match(sessionNavMeta(view.entries[0]), /^Chat/)
  assert.ok(sessionNavMeta(view.entries[0]).includes('Chat'))
  assert.ok(sessionNavMeta(view.entries[1]).startsWith('orbital-api'))
})

test('an empty list paints nothing and hides nothing', () => {
  const recent = buildSessionNav({
    sessions: [],
    projects,
    mode: 'recent',
    chatWorkspacePath: CHAT_WS
  })
  assert.equal(recent.mode, 'recent')
  if (recent.mode === 'recent') {
    assert.deepEqual(recent.entries, [])
    assert.equal(recent.hidden, 0)
  }
  const grouped = buildSessionNav({
    sessions: [],
    projects,
    mode: 'by-project',
    chatWorkspacePath: CHAT_WS
  })
  assert.equal(grouped.mode, 'by-project')
  if (grouped.mode === 'by-project') {
    assert.deepEqual(grouped.groups, [])
    assert.equal(grouped.hidden, 0)
  }
})

test('the limit caps recent and by-project the same way', () => {
  const sessions = Array.from({ length: 5 }, (_, i) =>
    session({
      id: `s${i}`,
      cwd: i % 2 === 0 ? '/home/dev/projects/orbital-api' : '/home/dev/projects/flux-dashboard',
      updatedAt: 1000 * (i + 1)
    })
  )
  const recent = buildSessionNav({
    sessions,
    projects,
    mode: 'recent',
    chatWorkspacePath: CHAT_WS,
    limit: 3
  })
  assert.equal(recent.mode, 'recent')
  if (recent.mode === 'recent') {
    assert.equal(recent.entries.length, 3)
    assert.equal(recent.hidden, 2)
    // Newest three of 1..5 → 5,4,3
    assert.deepEqual(
      recent.entries.map((e) => e.session.id),
      ['s4', 's3', 's2']
    )
  }
  const grouped = buildSessionNav({
    sessions,
    projects,
    mode: 'by-project',
    chatWorkspacePath: CHAT_WS,
    limit: 3
  })
  assert.equal(grouped.mode, 'by-project')
  if (grouped.mode === 'by-project') {
    const n = grouped.groups.reduce((sum, g) => sum + g.entries.length, 0)
    assert.equal(n, 3)
    assert.equal(grouped.hidden, 2)
  }
})

test('breaking recency order fails this suite (mutation pin)', () => {
  // If someone "simplifies" the comparator to updatedAt ascending, this fails.
  const sessions = [
    session({ id: 'old', cwd: '/a', updatedAt: 1 }),
    session({ id: 'new', cwd: '/b', updatedAt: 99 })
  ]
  const view = buildSessionNav({
    sessions,
    projects: [],
    mode: 'recent',
    chatWorkspacePath: null
  })
  assert.equal(view.mode, 'recent')
  if (view.mode !== 'recent') return
  assert.equal(view.entries[0].session.id, 'new')
  assert.notEqual(view.entries[0].session.id, 'old')
})
