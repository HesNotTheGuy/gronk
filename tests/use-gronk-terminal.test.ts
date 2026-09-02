import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { flush, mount } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'
import type { TerminalSession } from '../shared/types'

/**
 * Opening a terminal-TUI session must call session/resume with that id and
 * folder, and must not pretend Gronk has a local transcript.
 */

async function mountHook(overrides: Record<string, unknown> = {}) {
  const resumes: Array<{ id: unknown; folder: unknown; request: unknown }> = []
  const transcripts: string[] = []
  const bridge = installFakeBridge({
    listTerminalSessions: async () => [
      { id: 'cli-alpha', folder: '/tmp/tui-alpha', title: 'fix the parser', updatedAt: 9 }
    ],
    getTranscript: async (id: string) => {
      transcripts.push(id)
      return [{ id: 'fake', role: 'assistant', text: 'should not paint', createdAt: 1 }]
    },
    loadSession: async () => {
      throw new Error('loadSession must not run for a terminal session')
    },
    resumeTerminalSession: async (id: unknown, folder: unknown, request: unknown) => {
      resumes.push({ id, folder, request })
      return { sessionId: id, restored: false }
    },
    ...overrides
  })
  const { useGronk } = await import('../src/hooks/useGronk')
  let latest: Record<string, any> = {}
  function Probe() {
    latest = useGronk() as unknown as Record<string, any>
    return null
  }
  const view = await mount(createElement(Probe))
  await flush()
  return {
    hook: () => latest,
    resumes,
    transcripts,
    unmount: view.unmount,
    restore: bridge.restore
  }
}

const terminal = (over: Partial<TerminalSession> = {}): TerminalSession => ({
  id: 'cli-alpha',
  folder: '/tmp/tui-alpha',
  updatedAt: 9,
  title: 'fix the parser',
  ...over
})

test('selecting a terminal session resumes with that id plus its folder', async () => {
  const h = await mountHook()
  try {
    await act(async () => {
      await h.hook().selectTerminalSession(terminal())
    })
    await flush()
    assert.equal(h.resumes.length, 1)
    assert.equal(h.resumes[0].id, 'cli-alpha')
    assert.equal(h.resumes[0].folder, '/tmp/tui-alpha')
    assert.equal(typeof h.resumes[0].request, 'string')
    assert.equal(h.hook().openedFromTerminal, true)
    assert.equal(h.hook().sessionId, 'cli-alpha')
    assert.equal(h.hook().cwd, '/tmp/tui-alpha')
  } finally {
    h.unmount()
    h.restore()
  }
})

test('a terminal resume does not read or paint a local transcript', async () => {
  const h = await mountHook()
  try {
    await act(async () => {
      await h.hook().selectTerminalSession(terminal())
    })
    await flush()
    assert.deepEqual(h.transcripts, [])
    assert.deepEqual(h.hook().messages, [])
  } finally {
    h.unmount()
    h.restore()
  }
})

test('hydrate lists terminal sessions without mixing them into Gronk rows', async () => {
  const h = await mountHook()
  try {
    await flush()
    const ids = (h.hook().terminalSessions as TerminalSession[]).map((s) => s.id)
    assert.deepEqual(ids, ['cli-alpha'])
    const gronkIds = (h.hook().sessions as Array<{ id: string }>).map((s) => s.id)
    assert.equal(gronkIds.includes('cli-alpha'), false)
  } finally {
    h.unmount()
    h.restore()
  }
})
