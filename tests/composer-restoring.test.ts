import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { flush, mount } from './helpers/render'
import { Composer } from '../src/components/Composer'

/**
 * Restoring a session is not the agent working.
 *
 * `busy` is set by a real send and also by opening a session, and the composer
 * read the same for both: every restore said "Agent executing" and offered an
 * Abort button for a prompt nobody had sent. On a large store that was about a
 * minute of it, on a conversation the user had just clicked into.
 *
 * Found by serving the screenshot harness and opening a session in a browser.
 */

const props = (over: Record<string, unknown> = {}) =>
  ({
    hydrating: false,
    busy: false,
    connection: 'ready',
    authenticated: true,
    cwd: '/work/alpha',
    surface: 'project',
    permissionMode: 'default',
    onSend: () => {},
    onCancel: () => {},
    ...over
  }) as never

async function textOf(over: Record<string, unknown>) {
  const view = await mount(createElement(Composer, props(over)))
  await flush()
  const text = (document.body.textContent || '').replace(/\s+/g, ' ')
  return { text, unmount: view.unmount }
}

test('RESTORING DOES NOT CLAIM THE AGENT IS EXECUTING', async () => {
  const { text, unmount } = await textOf({ busy: true, hydrating: true })
  try {
    assert.ok(!text.includes('Agent executing'), 'a restore said the agent was executing')
    assert.ok(!text.includes('Abort'), 'a restore offered to abort a prompt nobody sent')
    assert.ok(text.includes('Restoring'), 'and it should say what it is actually doing')
  } finally {
    unmount()
  }
})

test('a real turn still says so and still offers Abort', async () => {
  const { text, unmount } = await textOf({ busy: true, hydrating: false })
  try {
    assert.ok(text.includes('Agent executing'))
    assert.ok(text.includes('Abort'))
  } finally {
    unmount()
  }
})

test('at rest it says neither', async () => {
  const { text, unmount } = await textOf({ busy: false, hydrating: false })
  try {
    assert.ok(!text.includes('Agent executing'))
    assert.ok(!text.includes('Abort'))
    assert.ok(!text.includes('Restoring'))
  } finally {
    unmount()
  }
})
