import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { flush, mount } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'
import { Sidebar } from '../src/components/Sidebar'
import type { AppSurface, MainToRendererEvent } from '../shared/types'

type Hook = Record<string, any>

interface Harness {
  hook: () => Hook
  emit: (event: MainToRendererEvent) => void
  unmount: () => void
  restore: () => void
}

async function mountHook(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const bridge = installFakeBridge(overrides)
  const { useGronk } = await import('../src/hooks/useGronk')
  let latest: Hook = {}
  function Probe() {
    latest = useGronk() as unknown as Hook
    return null
  }
  const view = await mount(createElement(Probe))
  await flush()
  return {
    hook: () => latest,
    emit: bridge.emit,
    unmount: view.unmount,
    restore: bridge.restore
  }
}

async function run(h: Harness, fn: (g: Hook) => Promise<void> | void): Promise<void> {
  await act(async () => {
    await fn(h.hook())
  })
  await flush()
  await flush()
}

function startedAt(cwd: unknown): string {
  if (typeof cwd !== 'string') throw new Error(`startAgent got ${String(cwd)}`)
  return cwd
}

;(globalThis as unknown as Record<string, string>).__APP_VERSION__ = '0.0.0-test'
;(globalThis as unknown as Record<string, string>).__APP_BUILD_LABEL__ = 'test'

const sidebarNoop = () => {}

function sidebar(over: Record<string, unknown> = {}) {
  return createElement(Sidebar, {
    authenticated: true,
    surface: 'project' as AppSurface,
    projects: [],
    projectSessions: [],
    chatSessions: [],
    chatWorkspacePath: '/data/chat-workspace',
    activeCwd: null,
    activeSessionId: null,
    archivedCount: 0,
    onGoHome: sidebarNoop,
    onGoChat: sidebarNoop,
    onGoProjects: sidebarNoop,
    onOpenProject: sidebarNoop,
    onOpenChat: sidebarNoop,
    onSelectSession: sidebarNoop,
    onRenameSession: sidebarNoop,
    onArchiveSession: sidebarNoop,
    onExportSession: sidebarNoop,
    onDeleteSession: sidebarNoop,
    onRemoveProject: sidebarNoop,
    onPinProject: sidebarNoop,
    onOpenPlugins: sidebarNoop,
    onNewProjectSession: sidebarNoop,
    onOpenArchived: sidebarNoop,
    onOpenSettings: sidebarNoop,
    onSignIn: sidebarNoop,
    ...over
  } as never)
}

test('NEW SESSION FROM AN OPEN PROJECT ASKS FOR A FOLDER', async () => {
  const started: string[] = []
  let asked = 0
  const h = await mountHook({
    selectFolder: async () => {
      asked += 1
      return '/work/beta'
    },
    startAgent: async (cwd: unknown) => {
      started.push(startedAt(cwd))
      return { sessionId: `s-${started.length}` }
    }
  })
  try {
    await run(h, (g) => g.openProject('/work/alpha'))
    assert.deepEqual(started, ['/work/alpha'])
    assert.equal(h.hook().cwd, '/work/alpha')

    await run(h, (g) => g.newChat())
    assert.equal(asked, 1, 'new session reused the open folder instead of asking')
    assert.deepEqual(started, ['/work/alpha', '/work/beta'])
    assert.equal(h.hook().cwd, '/work/beta')
    assert.equal(h.hook().sessionId, 's-2')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('CANCELLING THE FOLDER PICKER LEAVES THE OPEN PROJECT ALONE', async () => {
  const started: string[] = []
  const h = await mountHook({
    selectFolder: async () => null,
    startAgent: async (cwd: unknown) => {
      started.push(startedAt(cwd))
      return { sessionId: `s-${started.length}` }
    }
  })
  try {
    await run(h, (g) => g.openProject('/work/alpha'))
    const sessionId = h.hook().sessionId
    await run(h, (g) => g.newChat())
    assert.equal(h.hook().cwd, '/work/alpha', 'cancel bound a new session to the old path')
    assert.equal(h.hook().sessionId, sessionId, 'cancel replaced the open session')
    assert.deepEqual(started, ['/work/alpha'], 'cancel spawned another agent')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('CTRL+N FROM AN OPEN PROJECT ASKS FOR A FOLDER TOO', async () => {
  const started: string[] = []
  let asked = 0
  const h = await mountHook({
    selectFolder: async () => {
      asked += 1
      return '/work/beta'
    },
    startAgent: async (cwd: unknown) => {
      started.push(startedAt(cwd))
      return { sessionId: `s-${started.length}` }
    }
  })
  try {
    await run(h, (g) => g.openProject('/work/alpha'))
    await act(async () => {
      window.dispatchEvent(
        new window.KeyboardEvent('keydown', {
          key: 'n',
          ctrlKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    })
    await flush()
    await flush()
    assert.equal(asked, 1, 'Ctrl+N reused the open folder instead of asking')
    assert.deepEqual(started, ['/work/alpha', '/work/beta'])
  } finally {
    h.unmount()
    h.restore()
  }
})

test('THE SIDEBAR OFFERS NEW SESSION WITHOUT AN OPEN PROJECT', async () => {
  let clicked = 0
  const view = await mount(
    sidebar({
      activeCwd: null,
      onNewProjectSession: () => {
        clicked += 1
      }
    })
  )
  try {
    await flush()
    const btn = view.query('.session-nav-new') as HTMLButtonElement | null
    assert.ok(btn, 'no + New session button')
    assert.equal(btn.disabled, false, 'New session was gated on an already-open folder')
    assert.equal(
      btn.getAttribute('title')?.includes('SCFilters') || btn.getAttribute('title')?.includes('alpha'),
      false
    )
    await view.click(btn)
    assert.equal(clicked, 1)
  } finally {
    view.unmount()
  }
})

test('THE SIDEBAR DOES NOT PROMISE THE CURRENT FOLDER', async () => {
  const view = await mount(sidebar({ activeCwd: '/work/SCFilters' }))
  try {
    await flush()
    const btn = view.query('.session-nav-new') as HTMLButtonElement | null
    assert.ok(btn, 'no + New session button')
    const title = btn.getAttribute('title') ?? ''
    assert.equal(title.includes('SCFilters'), false, `title still named the open folder: ${title}`)
    assert.match(title, /folder/i)
  } finally {
    view.unmount()
  }
})
