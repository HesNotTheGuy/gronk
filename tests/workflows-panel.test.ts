import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { flush, mount } from './helpers/render'
import { PluginsPanel } from '../src/components/PluginsPanel'
import type { SavedWorkflow } from '../shared/types'

const WORKFLOWS: SavedWorkflow[] = [
  {
    name: 'deep-research',
    description: 'Research with bounded parallel agents',
    source: 'builtin',
    path: 'built-in',
    slash: '/deep-research'
  },
  {
    name: 'review-changes',
    description: 'Review a PR range',
    source: 'project',
    path: '.grok/workflows/review-changes.rhai',
    slash: '/review-changes'
  },
  {
    name: 'mine',
    description: 'Personal audit',
    source: 'user',
    path: '~/.grok/workflows/mine.rhai',
    slash: '/mine'
  }
]

function panelProps(over: Record<string, unknown> = {}) {
  return {
    open: true,
    installed: [],
    available: [],
    marketplaces: [],
    mcpServers: [],
    skills: [],
    workflows: WORKFLOWS,
    loading: false,
    error: null,
    busyName: null,
    onClose: () => {},
    onRefresh: () => {},
    onLoadCatalog: () => {},
    onInstall: () => {},
    onEnable: () => {},
    onDisable: () => {},
    onUninstall: () => {},
    onAddMcp: () => {},
    onRemoveMcp: () => {},
    ...over
  }
}

async function openWorkflows(over: Record<string, unknown> = {}) {
  const view = await mount(createElement(PluginsPanel, panelProps(over) as never))
  await flush()
  const tab = [...document.querySelectorAll('.plugins-tab')].find((el) =>
    (el.textContent ?? '').includes('Workflows')
  ) as HTMLButtonElement | undefined
  assert.ok(tab, 'no Workflows tab')
  await act(async () => {
    tab.click()
  })
  await flush()
  return view
}

test('the Workflows tab lists source and path for each saved script', async () => {
  const view = await openWorkflows()
  try {
    const text = document.body.textContent ?? ''
    assert.match(text, /review-changes/)
    assert.match(text, /\.grok\/workflows\/review-changes\.rhai/)
    assert.match(text, /project/)
    assert.match(text, /~\/\.grok\/workflows\/mine\.rhai/)
    assert.match(text, /yours/)
    assert.match(text, /deep-research/)
    assert.match(text, /built-in/)
    assert.doesNotMatch(text, /workspace/i)
  } finally {
    view.unmount()
  }
})

test('Use inserts the slash command and does not send it', async () => {
  const used: string[] = []
  const view = await openWorkflows({
    onUseCommand: (command: string) => used.push(command)
  })
  try {
    const useReview = [...document.querySelectorAll('.workflow-use')].find((el) =>
      (el.textContent ?? '').includes('/review-changes')
    ) as HTMLButtonElement | undefined
    assert.ok(useReview, 'no Use button for the project workflow')
    useReview.click()
    await flush()
    assert.deepEqual(used, ['/review-changes '])

    const runs = [...document.querySelectorAll('.workflow-controls button')].find((el) =>
      (el.textContent ?? '').includes('/workflow runs')
    ) as HTMLButtonElement | undefined
    assert.ok(runs)
    runs.click()
    await flush()
    assert.deepEqual(used, ['/review-changes ', '/workflow runs'])
  } finally {
    view.unmount()
  }
})

test('an empty catalog still offers the run-control slash lines', async () => {
  const used: string[] = []
  const view = await openWorkflows({ workflows: [], onUseCommand: (c: string) => used.push(c) })
  try {
    assert.match(document.body.textContent ?? '', /No saved workflows found/)
    const pause = [...document.querySelectorAll('.workflow-controls button')].find((el) =>
      (el.textContent ?? '').trim() === 'pause'
    ) as HTMLButtonElement | undefined
    assert.ok(pause)
    pause.click()
    await flush()
    assert.deepEqual(used, ['/workflow pause '])
  } finally {
    view.unmount()
  }
})
