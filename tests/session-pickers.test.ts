import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { flush, mount } from './helpers/render'
import { MenuButton } from '../src/components/MenuButton'

/**
 * The mode and model pickers under the composer.
 *
 * Reported: clicking the model you are already on should do nothing, and it instead
 * "gives it a new window". Both were true and connected — selecting a model wrote the
 * setting and restarted the agent, and a restart is `forceNew`, so choosing what you
 * already had replaced the conversation with an empty session.
 *
 * The third part of the same report is that these pickers should describe the session in
 * front of you. They read current settings, which is what the NEXT session will start
 * with — a different sentence, and wrong whenever a setting was changed without
 * restarting.
 */

const OPTIONS = [
  { id: 'grok-4.5', label: 'grok-4.5', description: 'default' },
  { id: 'grok-4', label: 'grok-4' }
]

async function openMenu(value: string, picked: string[]) {
  const view = await mount(
    createElement(MenuButton, {
      label: 'Model',
      title: 'Model',
      trigger: 'inline',
      placement: 'up',
      options: OPTIONS,
      value,
      onSelect: (id: string) => picked.push(id)
    } as never)
  )
  await flush()
  const trigger = view.query('.menu-btn')
  assert.ok(trigger, 'no trigger')
  await view.click(trigger)
  await flush()
  return view
}

const items = () => [...document.querySelectorAll('.menu-pop-item')] as HTMLButtonElement[]

/**
 * Find an option by its exact name.
 *
 * Not `textContent.includes`: the row carries its description too, and "grok-4" is a
 * prefix of "grok-4.5" — an earlier version of this file matched the current option while
 * believing it had found the other one, and asserted about the wrong button.
 */
const optionNamed = (name: string) =>
  items().find((b) => b.querySelector('.menu-pop-name')?.textContent?.trim() === name)

test('CHOOSING THE MODEL ALREADY IN USE DOES NOTHING', async () => {
  const picked: string[] = []
  const view = await openMenu('grok-4.5', picked)
  try {
    const current = optionNamed('grok-4.5')
    assert.ok(current, 'the current model is not listed')
    await view.click(current)
    await flush()
    assert.deepEqual(picked, [], 'selecting the current model asked for a change')
    assert.equal(items().length, 0, 'the menu stayed open')
  } finally {
    view.unmount()
  }
})

test('THE ONE IN FORCE IS MARKED, AND SAYS SO', async () => {
  const view = await openMenu('grok-4.5', [])
  try {
    const current = optionNamed('grok-4.5')!
    const other = optionNamed('grok-4')!
    assert.match(current.className, /current/)
    assert.equal(current.getAttribute('aria-disabled'), 'true')
    assert.match(current.getAttribute('title') ?? '', /already using/i)
    assert.notEqual(other.getAttribute('aria-disabled'), 'true', 'the other one is unusable')
  } finally {
    view.unmount()
  }
})

test('CHOOSING A DIFFERENT MODEL STILL ASKS FOR IT', async () => {
  // The guard must not make the picker inert.
  const picked: string[] = []
  const view = await openMenu('grok-4.5', picked)
  try {
    const other = optionNamed('grok-4')
    assert.ok(other, 'the other model is not listed')
    await view.click(other)
    await flush()
    assert.deepEqual(picked, ['grok-4'])
  } finally {
    view.unmount()
  }
})

test('THE PICKERS DESCRIBE THE SESSION, NOT THE SETTINGS', async () => {
  // Read from source: this is which value App hands down, and the difference only shows
  // with a live session whose model differs from the saved default — which needs a real
  // agent. What is pinned is that the session's value is preferred and the setting is the
  // fallback, in that order.
  const { readFileSync } = await import('node:fs')
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

  assert.match(app, /currentModel=\{g\.sessionModel \?\? g\.settings\?\.model\}/)
  assert.match(app, /permissionMode=\{g\.sessionPermissionMode \?\? g\.permissionMode\}/)
  // And the change handlers are told what is running, so their own guard compares
  // against the session rather than the setting.
  assert.match(app, /g\.changeModel\(id, g\.sessionModel\)/)
  assert.match(app, /g\.changePermissionMode\(m, g\.sessionPermissionMode\)/)
})
