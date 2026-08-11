import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { flush, mount } from './helpers/render'
import { SessionTray } from '../src/components/SessionTray'
import type { AuthStatus, SessionUsage } from '../shared/types'

/**
 * How the usage panel words its numbers.
 *
 * A real misreading, from the maintainer looking at their own session: `Cached 86.2M
 * 97%` was read as "97% of my tokens are gone". It means the opposite — 97% of the
 * prompt tokens were reused from cache rather than read again, which is the number you
 * want high. A large number with a bare percentage beside it reads as a fuel gauge, and
 * the explanation was in the smallest text at the bottom of the panel, which is too
 * late.
 *
 * The rule these pin: the share never appears without a word saying what it is.
 */

const usage: SessionUsage = {
  sessionId: 's1',
  turns: 3,
  totals: {
    inputTokens: 89_100_000,
    outputTokens: 216_000,
    cachedReadTokens: 86_200_000,
    reasoningTokens: 124_000,
    modelCalls: 390,
    apiDurationMs: 5_218_000,
    costUsd: 585.24
  } as SessionUsage['totals']
}

const auth = { state: 'authenticated', authenticated: true, method: 'session' } as AuthStatus

async function openUsage() {
  const view = await mount(
    createElement(SessionTray, {
      showPlan: false,
      sessionId: 's1',
      plan: null,
      messages: [],
      usage,
      auth,
      showChanges: false,
      notesCwd: null,
      notes: {},
      onSaveNote: () => {}
    } as never)
  )
  await flush()
  const tab = view.queryAll('button').find((b) => /usage|tokens|\$/i.test(b.textContent ?? ''))
  if (tab) await view.click(tab)
  await flush()
  return view
}

test('THE CACHE SHARE IS NEVER A BARE PERCENTAGE', async () => {
  const view = await openUsage()
  try {
    const text = (view.text() || '').replace(/\s+/g, ' ')
    assert.match(text, /97%/, 'the share is not shown at all')
    assert.match(
      text,
      /97% reused/,
      'a bare percentage beside a large number reads as a quota gauge'
    )
  } finally {
    view.unmount()
  }
})

test('NOTHING IN THE PANEL CLAIMS TO KNOW A QUOTA', async () => {
  // The app cannot see what the account has left: the CLI reports what a session
  // consumed, not what remains. This checks the CLAIM rather than the vocabulary — an
  // earlier version banned the words, which failed the sentence that says plainly the
  // panel is not a quota reading. What must not appear is a number presented as an
  // amount remaining.
  const view = await openUsage()
  try {
    const text = (view.text() || '').replace(/\s+/g, ' ')
    for (const claim of [
      /\d[\d.,]*\s*(tokens?\s*)?(remaining|left)/i,
      /\d+%\s*(of\s+)?(your\s+)?(quota|limit|plan)/i,
      /\d+%\s*used/i
    ]) {
      assert.doesNotMatch(text, claim, 'the panel states an amount it cannot know')
    }
    // And it says so out loud, because silence here is what got misread in the first place.
    assert.match(
      text,
      /a quota reading|never what the plan has left|counts against a quota this app can see/i,
      'the panel does not say that it cannot see a quota, which is what got misread'
    )
  } finally {
    view.unmount()
  }
})

test('THE COST FIGURE SAYS WHAT IT IS WHERE IT IS SHOWN', async () => {
  // The largest, most alarming number on the panel, and billed to nobody on a plan.
  // Its label carries the framing, so the figure is never a naked dollar amount.
  const view = await openUsage()
  try {
    const text = (view.text() || '').replace(/\s+/g, ' ')
    assert.match(text, /At API rates/, 'the cost figure lost the label that frames it')
  } finally {
    view.unmount()
  }
})
