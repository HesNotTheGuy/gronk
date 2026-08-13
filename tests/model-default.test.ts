import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { ensureDom, flush, mount } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'
import { SettingsPanel } from '../src/components/SettingsPanel'
import type { AppSettings, ModelInfo } from '../shared/types'

/**
 * The model an install starts new sessions with, and the way back out of one.
 *
 * How this went wrong in the field: the CLI moved its default to 4.6 and the app kept
 * starting every session on 4.5, because `settings.model` held that id and Gronk passes
 * it as `-m` on every spawn. Nothing had gone wrong mechanically. There was simply no
 * option meaning "no stored model", so once a value was written — by any picker, once,
 * at any point in the past — it outlived every model release after it.
 *
 * Two properties, and the dropdown is worth mounting for both: an empty value must be
 * offered and must be reachable, and a pinned install must be distinguishable from an
 * unpinned one by looking at this screen.
 */

const MODELS: ModelInfo[] = [
  { id: 'grok-4.6', name: 'Grok 4.6', isDefault: true },
  { id: 'grok-4.5', name: 'Grok 4.5' }
]

const SETTINGS = (model?: string): AppSettings =>
  ({
    permissionMode: 'default',
    alwaysApprove: false,
    alwaysApproveAck: false,
    theme: 'dark',
    ...(model ? { model } : {})
  }) as AppSettings

async function panel(model: string | undefined, picked: string[] = []) {
  // The panel probes the CLI version on mount, so it needs a bridge to be on screen at all.
  const bridge = installFakeBridge()
  const view = await mount(
    createElement(SettingsPanel, {
      open: true,
      settings: SETTINGS(model),
      models: MODELS,
      grokPath: '/usr/bin/grok',
      audit: [],
      health: null,
      auth: { authenticated: true, hasAuthFile: true, message: '' },
      authBusy: false,
      dataLocation: null,
      dataBusy: false,
      dataError: null,
      dataNotice: null,
      onClose: () => {},
      onChangeModel: (id: string) => picked.push(id),
      onToggleYolo: () => {},
      onChangeTheme: () => {},
      onPickBinary: () => {},
      onClearBinary: () => {},
      onRefreshHealth: () => {},
      onLogin: () => {},
      onLogout: () => {},
      onChooseDataDir: async () => null,
      onMoveDataDir: () => {},
      onResetDataDir: () => {}
    } as never)
  )
  await flush()
  // By label, not by class: `model-select` is shared styling and the theme dropdown
  // above wears it too, so a class query silently reads the wrong control.
  const select = view.query('select[aria-label="Model for new sessions"]') as HTMLSelectElement | null
  assert.ok(select, 'the model dropdown is not on the settings screen')
  return { view: { unmount: () => { view.unmount(); bridge.restore() } }, select, picked }
}

/**
 * Pick an option the way a person does.
 *
 * Through the prototype setter, then a real event: React overrides `value` on the
 * element it controls to track what it last wrote, so assigning `select.value` directly
 * leaves the tracker believing nothing changed and the handler never runs. Same shape as
 * `type()` in session-drafts.test.ts.
 */
async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  const window = ensureDom().window
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
  assert.ok(setter, 'jsdom has no select value setter')
  await act(async () => {
    setter.call(select, value)
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await flush()
}

test('AN UNPINNED INSTALL IS OFFERED AS A CHOICE, NAMING WHAT IT RESOLVES TO', async () => {
  const { view, select } = await panel(undefined)
  try {
    const follow = [...select.options].find((o) => o.value === '')
    assert.ok(follow, 'there is no way to store no model at all')
    // Named, so the choice is not blind: this is what grok is defaulting to today.
    assert.match(follow.textContent ?? '', /Grok 4\.6/)
    assert.equal(select.value, '', 'an install with nothing stored did not read as unpinned')
  } finally {
    view.unmount()
  }
})

test('A PINNED INSTALL LOOKS DIFFERENT FROM AN UNPINNED ONE', async () => {
  // The whole failure was that it did not. This screen showed grok's default whether or
  // not a model was stored, so the one place that could have reported the pin agreed
  // with the app that was ignoring it.
  const pinned = await panel('grok-4.5')
  try {
    assert.equal(pinned.select.value, 'grok-4.5')
  } finally {
    pinned.view.unmount()
  }

  const free = await panel(undefined)
  try {
    assert.notEqual(free.select.value, 'grok-4.5')
    assert.notEqual(
      free.select.value,
      'grok-4.6',
      'an unpinned install claimed to have grok’s default stored'
    )
  } finally {
    free.view.unmount()
  }
})

test('CHOOSING IT ASKS FOR THE PIN TO BE CLEARED', async () => {
  const picked: string[] = []
  const { view, select } = await panel('grok-4.5', picked)
  try {
    await choose(select, '')
    // Empty string, not undefined: Electron IPC drops undefined keys, so that is what
    // the store reads as an explicit clear.
    assert.deepEqual(picked, [''])
  } finally {
    view.unmount()
  }
})
