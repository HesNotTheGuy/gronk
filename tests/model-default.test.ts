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

async function panel(
  model: string | undefined,
  picked: string[] = [],
  extra: { models?: ModelInfo[]; effort?: string; onEffort?: (e: string) => void } = {}
) {
  // The panel probes the CLI version on mount, so it needs a bridge to be on screen at all.
  const bridge = installFakeBridge()
  const view = await mount(
    createElement(SettingsPanel, {
      open: true,
      settings: { ...SETTINGS(model), ...(extra.effort ? { reasoningEffort: extra.effort } : {}) },
      models: extra.models ?? MODELS,
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
      onChangeReasoningEffort: (e: string) => extra.onEffort?.(e),
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
  const effortSelect = view.query(
    'select[aria-label="Reasoning effort for new sessions"]'
  ) as HTMLSelectElement | null
  return {
    view: { unmount: () => { view.unmount(); bridge.restore() } },
    select,
    effortSelect,
    picked
  }
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

/**
 * Effort levels are per-model, and 4.6 is the reason this cannot be a fixed list.
 *
 * grok-4.5 offers three levels; grok-4.6 offers four, `xhigh` being the new one. A
 * hardcoded list would either hide xhigh on 4.6 or offer it on 4.5, where it does not
 * exist — so the picker reads what the agent reported for the model in force.
 */
test('THE LEVELS OFFERED COME FROM THE MODEL, NOT FROM A FIXED LIST', async () => {
  const { parseModelState } = await import('../electron/main/acp/client')

  const parsed = parseModelState({
    modelState: {
      currentModelId: 'grok-4.6',
      availableModels: [
        {
          modelId: 'grok-4.6',
          name: 'Grok 4.6',
          _meta: {
            totalContextTokens: 500000,
            supportsReasoningEffort: true,
            reasoningEffort: 'high',
            reasoningEfforts: [
              { id: 'xhigh', label: 'Extra High Effort', default: true },
              { id: 'high', label: 'High Effort', default: true },
              { id: 'medium', label: 'Medium Effort' },
              { id: 'low', label: 'Low Effort' }
            ]
          }
        },
        {
          modelId: 'grok-4.5',
          name: 'Grok 4.5',
          _meta: {
            supportsReasoningEffort: true,
            reasoningEfforts: [{ id: 'high', label: 'High Effort' }, { id: 'low', label: 'Low' }]
          }
        }
      ]
    }
  })

  const [newer, older] = parsed.models
  assert.equal(parsed.current, 'grok-4.6')
  assert.deepEqual(newer.reasoningEfforts?.map((e) => e.id), ['xhigh', 'high', 'medium', 'low'])
  assert.deepEqual(older.reasoningEfforts?.map((e) => e.id), ['high', 'low'])
  assert.equal(newer.defaultReasoningEffort, 'high')
  assert.equal(newer.contextTokens, 500000)
  assert.equal(newer.isDefault, true)
})

test('A LEVEL THE APP DOES NOT KNOW IS NOT OFFERED', async () => {
  const { parseModelState } = await import('../electron/main/acp/client')

  // These ids become the value of `--reasoning-effort`, which grok does not validate,
  // so an unrecognised one must not survive far enough to be clickable.
  const { models } = parseModelState({
    modelState: {
      availableModels: [
        {
          modelId: 'grok-9',
          _meta: {
            supportsReasoningEffort: true,
            reasoningEfforts: [
              { id: 'ultra', label: 'Ultra' },
              { id: 'low', label: 'Low' },
              // 4.6 really does report two entries flagged default; a list built
              // straight from the payload can also repeat a level.
              { id: 'low', label: 'Low again' }
            ]
          }
        }
      ]
    }
  })

  assert.deepEqual(models[0].reasoningEfforts?.map((e) => e.id), ['low'])
})

test('SAYING NOTHING ABOUT EFFORT IS NOT THE SAME AS SUPPORTING NONE', async () => {
  const { parseModelState } = await import('../electron/main/acp/client')

  // An agent that reports no effort metadata leaves the flag undefined rather than
  // false. The panel shows no picker either way, but "we do not know" must not be
  // recorded as a claim that the model has no levels.
  const { models } = parseModelState({
    modelState: { availableModels: [{ modelId: 'grok-x', name: 'X' }] }
  })
  assert.equal(models[0].supportsReasoningEffort, undefined)
  assert.equal(models[0].reasoningEfforts, undefined)

  assert.deepEqual(parseModelState(undefined), { models: [], current: undefined })
  assert.deepEqual(parseModelState({ modelState: { availableModels: 'nope' } }).models, [])
})

const WITH_EFFORT: ModelInfo[] = [
  {
    id: 'grok-4.6',
    name: 'Grok 4.6',
    isDefault: true,
    supportsReasoningEffort: true,
    defaultReasoningEffort: 'high',
    reasoningEfforts: [
      { id: 'xhigh', label: 'Extra High Effort' },
      { id: 'high', label: 'High Effort' },
      { id: 'medium', label: 'Medium Effort' },
      { id: 'low', label: 'Low Effort' }
    ]
  },
  {
    id: 'grok-4.5',
    name: 'Grok 4.5',
    supportsReasoningEffort: true,
    reasoningEfforts: [{ id: 'high', label: 'High Effort' }]
  }
]

test('THE EFFORT PICKER OFFERS WHAT THE CHOSEN MODEL HAS, AND ONLY THAT', async () => {
  // Pinned to 4.5, which offers one level — so xhigh must not be on screen. Reading the
  // levels off the default model instead would offer a level the session cannot use.
  const pinned = await panel('grok-4.5', [], { models: WITH_EFFORT })
  try {
    assert.ok(pinned.effortSelect, 'no effort picker for a model that supports it')
    const ids = [...pinned.effortSelect.options].map((o) => o.value)
    assert.deepEqual(ids, ['', 'high'])
  } finally {
    pinned.view.unmount()
  }

  const unpinned = await panel(undefined, [], { models: WITH_EFFORT })
  try {
    const ids = [...unpinned.effortSelect!.options].map((o) => o.value)
    assert.deepEqual(ids, ['', 'xhigh', 'high', 'medium', 'low'], 'xhigh is 4.6-only and missing')
  } finally {
    unpinned.view.unmount()
  }
})

test('A MODEL WITH NO LEVELS GETS NO PICKER AT ALL', async () => {
  const { view, effortSelect } = await panel(undefined, [], { models: MODELS })
  try {
    assert.equal(effortSelect, null, 'offered effort for a model that reported none')
  } finally {
    view.unmount()
  }
})

test('THE MODEL DEFAULT IS AN OPTION, AND IS NOT THE SAME AS NAMING THAT LEVEL', async () => {
  const chosen: string[] = []
  const { view, effortSelect } = await panel(undefined, [], {
    models: WITH_EFFORT,
    onEffort: (e) => chosen.push(e)
  })
  try {
    // Empty means no flag at all, so the level follows the model if the model changes
    // it. Naming 'high' explicitly pins it and would not follow. They must be distinct.
    const follow = [...effortSelect!.options].find((o) => o.value === '')
    assert.match(follow?.textContent ?? '', /high/i, 'the default level is not named')
    assert.equal(effortSelect!.value, '', 'an install with nothing stored did not read as unset')

    await choose(effortSelect!, 'xhigh')
    assert.deepEqual(chosen, ['xhigh'])
  } finally {
    view.unmount()
  }
})
