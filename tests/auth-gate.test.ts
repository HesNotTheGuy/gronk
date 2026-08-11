import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { mount } from './helpers/render'
import { AuthGate } from '../src/components/AuthGate'
import type { AuthStatus, LoginMethod } from '../shared/types'

/**
 * The sign-in screen while a sign-in is waiting.
 *
 * A browser login waits up to three minutes for a flow that may never come back:
 * the browser did not open, or it was closed. One `busy` flag disabled all three
 * buttons for that whole window, which took away device code — the remedy this
 * very screen recommends when a browser will not do — and left nothing to do but
 * restart the app. Which button is disabled is the whole subject here.
 */

const auth: AuthStatus = {
  state: 'unauthenticated',
  authenticated: false,
  message: 'Not signed in'
} as AuthStatus

const props = {
  auth,
  busy: false,
  grokFound: true,
  onLogin: () => {},
  onRefresh: () => {},
  onOpenSettings: () => {},
  onInstallCli: () => {}
}

const gate = (over: Partial<typeof props> & { pendingLogin?: LoginMethod | null } = {}) =>
  mount(createElement(AuthGate, { ...props, ...over }))

const buttons = (view: Awaited<ReturnType<typeof gate>>) =>
  view.queryAll('.auth-actions button') as HTMLButtonElement[]

test('A BROWSER SIGN-IN STILL WAITING LEAVES DEVICE CODE USABLE', async () => {
  const view = await gate({ busy: true, pendingLogin: 'oauth' })
  try {
    const [browser, device, recheck] = buttons(view)
    assert.equal(browser.disabled, true, 'the one being waited on')
    assert.equal(device.disabled, false, 'the way out of that wait')
    assert.equal(recheck.disabled, false, 'a read-only probe is never taken away')
    assert.match(device.textContent ?? '', /device code/i)
  } finally {
    view.unmount()
  }
})

test('A DEVICE SIGN-IN STILL WAITING LEAVES BROWSER LOGIN USABLE', async () => {
  const view = await gate({ busy: true, pendingLogin: 'device' })
  try {
    const [browser, device] = buttons(view)
    assert.equal(device.disabled, true)
    assert.equal(browser.disabled, false, 'either method can replace the other')
  } finally {
    view.unmount()
  }
})

test('RE-CHECK STATUS IS NEVER DISABLED', async () => {
  // It is what a person reaches for when a screen looks stuck, and it only reads.
  for (const pendingLogin of ['oauth', 'device', null] as (LoginMethod | null)[]) {
    const view = await gate({ busy: true, pendingLogin })
    try {
      assert.equal(buttons(view)[2].disabled, false, `pending: ${pendingLogin}`)
    } finally {
      view.unmount()
    }
  }
})

test('WITHOUT THE CLI THERE IS NOTHING TO SIGN IN WITH', async () => {
  // The pre-existing reason both methods are unavailable, which the change above
  // must not have dropped: no binary, no login, by either route.
  const view = await gate({ grokFound: false })
  try {
    const [browser, device] = buttons(view)
    assert.equal(browser.disabled, true)
    assert.equal(device.disabled, true)
  } finally {
    view.unmount()
  }
})

test('WITH NOTHING PENDING, BOTH METHODS OFFER THEMSELVES PLAINLY', async () => {
  const view = await gate()
  try {
    const [browser, device] = buttons(view)
    assert.equal(browser.disabled, false)
    assert.equal(device.disabled, false)
    assert.match(browser.textContent ?? '', /sign in with browser/i)
    assert.doesNotMatch(device.textContent ?? '', /instead/i)
  } finally {
    view.unmount()
  }
})
