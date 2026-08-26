import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { ensureDom, flush, mount } from './helpers/render'
import { MenuButton } from '../src/components/MenuButton'

/**
 * Two properties of the shared menu:
 * - a dismissing click closes the menu and activates nothing (letting it land selects
 *   — or in the archived list, restores — whatever sits under the pointer)
 * - focus follows the menu into its portal and returns to the trigger on every exit,
 *   or the items sit at the end of the document's tab order, unreachable
 */

const OPTIONS = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' }
]

async function mountMenuBesideButton() {
  const outsideClicks: number[] = []
  const picked: string[] = []
  const view = await mount(
    createElement(
      'div',
      null,
      createElement(MenuButton, {
        label: 'Actions',
        trigger: 'inline',
        options: OPTIONS,
        value: 'b',
        onSelect: (id: string) => picked.push(id)
      } as never),
      createElement(
        'button',
        { type: 'button', id: 'neighbour', onClick: () => outsideClicks.push(1) },
        'Another card'
      )
    )
  )
  await flush()
  const trigger = view.query('.menu-btn')
  assert.ok(trigger, 'no trigger')
  await view.click(trigger)
  await flush()
  return { view, outsideClicks, picked }
}

const win = () => ensureDom().window

/** A real dismissal gesture: mousedown, then the click it becomes, on the same target. */
async function dismissOn(target: Element): Promise<void> {
  const w = win()
  target.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  await flush()
  target.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }))
  await flush()
}

test('DISMISSING THE MENU BY CLICKING ELSEWHERE DOES NOT ACTIVATE WHAT WAS CLICKED', async () => {
  const { view, outsideClicks } = await mountMenuBesideButton()
  try {
    assert.ok(document.querySelector('.menu-pop'), 'the menu did not open')
    const neighbour = document.getElementById('neighbour')!
    await dismissOn(neighbour)

    assert.ok(!document.querySelector('.menu-pop'), 'the menu did not close')
    assert.deepEqual(outsideClicks, [], 'the dismissing click activated the neighbour')

    // The NEXT click is a new intention and must land.
    neighbour.dispatchEvent(new (win()).MouseEvent('click', { bubbles: true, cancelable: true }))
    await flush()
    assert.deepEqual(outsideClicks, [1], 'the swallow ate a later, deliberate click')
  } finally {
    view.unmount()
  }
})

test('OPENING THE MENU MOVES FOCUS TO THE OPTION IN FORCE', async () => {
  const { view } = await mountMenuBesideButton()
  try {
    const focused = document.activeElement as HTMLElement | null
    assert.ok(focused?.classList.contains('menu-pop-item'), 'focus did not enter the menu')
    assert.equal(
      focused?.querySelector('.menu-pop-name')?.textContent?.trim(),
      'Beta',
      'focus landed somewhere other than the current option'
    )
  } finally {
    view.unmount()
  }
})

test('ARROWS MOVE FOCUS, AND ESCAPE PUTS IT BACK ON THE TRIGGER', async () => {
  const { view } = await mountMenuBesideButton()
  try {
    const pop = document.querySelector('.menu-pop')!
    const w = win()

    pop.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flush()
    assert.equal(
      (document.activeElement as HTMLElement).querySelector('.menu-pop-name')?.textContent?.trim(),
      'Gamma'
    )
    // Wraps rather than stopping: Gamma is last, down again is Alpha.
    pop.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await flush()
    assert.equal(
      (document.activeElement as HTMLElement).querySelector('.menu-pop-name')?.textContent?.trim(),
      'Alpha'
    )

    document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flush()
    assert.ok(!document.querySelector('.menu-pop'), 'Escape did not close the menu')
    assert.ok(
      (document.activeElement as HTMLElement | null)?.classList.contains('menu-btn'),
      'focus was stranded instead of returning to the trigger'
    )
  } finally {
    view.unmount()
  }
})

test('SELECTING RETURNS FOCUS TO THE TRIGGER', async () => {
  const { view, picked } = await mountMenuBesideButton()
  try {
    const items = [...document.querySelectorAll('.menu-pop-item')] as HTMLButtonElement[]
    const alpha = items.find((b) => b.textContent?.includes('Alpha'))!
    await view.click(alpha)
    await flush()
    assert.deepEqual(picked, ['a'])
    assert.ok(
      (document.activeElement as HTMLElement | null)?.classList.contains('menu-btn'),
      'focus was stranded after selecting'
    )
  } finally {
    view.unmount()
  }
})
