import test from 'node:test'
import assert from 'node:assert/strict'
import type { WebContents } from 'electron'
import { buildContextMenu, type ContextTarget } from '../electron/main/context-menu-items'
import { installContextMenu, runContextAction } from '../electron/main/context-menu'
import { __captureClipboard, __reset } from './stubs/electron'

/**
 * The right-click menu: what it offers, and what each item does when clicked.
 *
 * The failure the first half guards against is a menu that offers an action the
 * target cannot perform. Paste on a read-only field, or Cut with nothing
 * selected, is how a menu teaches people to stop trusting it.
 *
 * WHAT IS AND IS NOT COVERED, because an earlier version of this comment
 * claimed the untested half "has no branches" and that was simply false.
 *
 * Covered: buildContextMenu, and runContextAction, which is reached by handing
 * it a fake WebContents. That is every switch arm, both inner `if (item.word)`
 * guards, and the destroyed-page check. Of installContextMenu, the listener
 * registration and the empty-menu early return.
 *
 * NOT covered: everything in installContextMenu past that early return. Mapping
 * items onto a template, the separator branch in that mapping, and
 * `Menu.popup()` all need a real `Menu`, which cannot be constructed under
 * `node --test` at all, so a test cannot get past the line that builds one.
 * Nor is any of the wiring covered: the menu is installed on the main window
 * and on both preview surfaces, and none of those has been opened. Nobody has
 * launched this app and seen this menu appear.
 */

/** Records what was called instead of driving a real page. */
function fakeWebContents(): { wc: WebContents; calls: string[] } {
  const calls: string[] = []
  const rec =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push(args.length ? `${method}:${String(args[0])}` : method)
    }
  const wc = {
    isDestroyed: () => false,
    cut: rec('cut'),
    copy: rec('copy'),
    paste: rec('paste'),
    selectAll: rec('selectAll'),
    replaceMisspelling: rec('replaceMisspelling'),
    session: { addWordToSpellCheckerDictionary: rec('addWord') }
  }
  return { wc: wc as unknown as WebContents, calls }
}

/**
 * A page that is already gone. Every member throws the way Electron's own
 * bindings do, so a missing liveness check shows up as the throw it would be in
 * production rather than as a quietly absent call.
 */
function destroyedWebContents(): WebContents {
  const boom = (): never => {
    throw new Error('Object has been destroyed')
  }
  return {
    isDestroyed: () => true,
    cut: boom,
    copy: boom,
    paste: boom,
    selectAll: boom,
    replaceMisspelling: boom,
    get session(): never {
      return boom()
    }
  } as unknown as WebContents
}

function target(overrides: Partial<ContextTarget> = {}): ContextTarget {
  return {
    isEditable: false,
    selectionText: '',
    misspelledWord: '',
    dictionarySuggestions: [],
    linkURL: '',
    editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false },
    ...overrides
  }
}

const ids = (t: ContextTarget) => buildContextMenu(t).map((i) => i.id)

test('right-clicking nothing offers nothing', () => {
  // An empty menu means the caller shows no menu at all. A grey empty box on
  // right-click looks more broken than no menu does.
  assert.deepEqual(buildContextMenu(target()), [])
})

test('an editable field offers the editing verbs', () => {
  const menu = ids(
    target({
      isEditable: true,
      editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
    })
  )
  assert.deepEqual(menu, ['cut', 'copy', 'paste', 'separator', 'selectAll'])
})

test('enablement follows editFlags, not guesswork', () => {
  // Chromium computes these for the actual target. An empty field can be pasted
  // into but has nothing to cut, and that distinction has to survive.
  const menu = buildContextMenu(
    target({
      isEditable: true,
      editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: false }
    })
  )
  const byId = Object.fromEntries(menu.map((i) => [i.id, i.enabled]))
  assert.equal(byId.cut, false)
  assert.equal(byId.copy, false)
  assert.equal(byId.paste, true)
  assert.equal(byId.selectAll, false)
})

test('read-only text with a selection offers copy and nothing else', () => {
  // Select All on a transcript selects the surrounding chrome too, which is
  // never what someone means by it.
  assert.deepEqual(
    ids(target({ selectionText: 'some words', editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true } })),
    ['copy']
  )
})

test('a whitespace-only selection is not a selection', () => {
  assert.deepEqual(ids(target({ selectionText: '   \n  ' })), [])
})

test('spelling suggestions come first, above the editing verbs', () => {
  // The correction is what the user right-clicked the red underline for. Below
  // Cut it may as well not be there.
  const menu = ids(
    target({
      isEditable: true,
      misspelledWord: 'recieve',
      dictionarySuggestions: ['receive', 'relieve'],
      editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
    })
  )
  assert.deepEqual(menu, [
    'suggestion',
    'suggestion',
    'addToDictionary',
    'separator',
    'cut',
    'copy',
    'paste',
    'separator',
    'selectAll'
  ])
})

test('a suggestion carries the replacement word, not just its label', () => {
  const menu = buildContextMenu(
    target({ isEditable: true, misspelledWord: 'recieve', dictionarySuggestions: ['receive'] })
  )
  const first = menu[0]
  assert.equal(first.id, 'suggestion')
  assert.equal(first.word, 'receive')
  assert.equal(first.label, 'receive')
})

test('add to dictionary carries the misspelled word', () => {
  // Without this the handler has nothing to add, which is a menu item that
  // silently does nothing. That exact bug existed in the first draft.
  const menu = buildContextMenu(
    target({ isEditable: true, misspelledWord: 'gronk', dictionarySuggestions: ['grok'] })
  )
  const add = menu.find((i) => i.id === 'addToDictionary')
  assert.ok(add, 'no add-to-dictionary item')
  assert.equal(add.word, 'gronk')
})

test('a misspelling with no suggestions says so rather than staying silent', () => {
  const menu = buildContextMenu(
    target({ isEditable: true, misspelledWord: 'xyzzyx', dictionarySuggestions: [] })
  )
  assert.equal(menu[0].label, 'No suggestions')
  assert.equal(menu[0].enabled, false)
  assert.ok(menu.some((i) => i.id === 'addToDictionary'))
})

test('the suggestion list is capped', () => {
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
  const menu = buildContextMenu(
    target({ isEditable: true, misspelledWord: 'x', dictionarySuggestions: many })
  )
  assert.equal(menu.filter((i) => i.id === 'suggestion').length, 5)
})

test('spelling is not offered outside an editable field', () => {
  // Chromium can report a misspelling on rendered text. There is nothing to
  // replace it in, so offering the correction would do nothing when clicked.
  assert.deepEqual(
    ids(target({ isEditable: false, misspelledWord: 'recieve', dictionarySuggestions: ['receive'] })),
    []
  )
})

test('a link can be copied, and its label is truncated', () => {
  const long = `https://example.com/${'x'.repeat(200)}`
  const menu = buildContextMenu(target({ linkURL: long }))
  const link = menu.find((i) => i.id === 'copyLink')
  assert.ok(link)
  assert.equal(link.url, long, 'the full url must survive even when the label does not')

  // Bounded in both directions on purpose. `< 80` alone cannot fail in the
  // direction that matters: measured on this suite, MAX_LINK_LABEL could sit
  // anywhere in 1..68 with all 14 tests green, and at 1 the label reads
  // "Copy link: …" with the destination gone entirely. On the preview pane the
  // url is whatever an untrusted local page served, so a label that hides the
  // host is the failure worth catching.
  assert.equal(link.label.length, 71, `label was ${link.label.length} chars: ${link.label}`)
  assert.ok(link.label.endsWith('…'))
  assert.ok(
    link.label.includes('example.com'),
    `the destination host must survive truncation, got ${link.label}`
  )
})

test('no menu ever starts or ends with a separator, or doubles one', () => {
  // Each block adds its own divider without knowing whether anything follows,
  // which is what keeps them independent. This is where that cost is paid.
  const cases: ContextTarget[] = [
    target({ isEditable: true, misspelledWord: 'x', dictionarySuggestions: ['y'] }),
    target({ linkURL: 'https://example.com' }),
    target({ selectionText: 'hi', linkURL: 'https://example.com' }),
    target({
      isEditable: true,
      misspelledWord: 'x',
      dictionarySuggestions: ['y'],
      linkURL: 'https://example.com'
    })
  ]
  for (const c of cases) {
    const menu = buildContextMenu(c)
    assert.notEqual(menu[0]?.id, 'separator', 'leading separator')
    assert.notEqual(menu[menu.length - 1]?.id, 'separator', 'trailing separator')
    for (let i = 1; i < menu.length; i++) {
      assert.ok(
        !(menu[i].id === 'separator' && menu[i - 1].id === 'separator'),
        `doubled separator at ${i}`
      )
    }
  }
})

test('each item drives the matching webContents call', () => {
  // Previously unreachable: runContextAction was module-private and nothing in
  // the suite loaded it. Every one of these arms was shipped unexercised.
  const cases: Array<[Parameters<typeof runContextAction>[1], string]> = [
    [{ id: 'cut', label: 'Cut', enabled: true }, 'cut'],
    [{ id: 'copy', label: 'Copy', enabled: true }, 'copy'],
    [{ id: 'paste', label: 'Paste', enabled: true }, 'paste'],
    [{ id: 'selectAll', label: 'Select all', enabled: true }, 'selectAll'],
    [
      { id: 'suggestion', label: 'receive', enabled: true, word: 'receive' },
      'replaceMisspelling:receive'
    ],
    [
      { id: 'addToDictionary', label: 'Add to dictionary', enabled: true, word: 'gronk' },
      'addWord:gronk'
    ]
  ]
  for (const [item, expected] of cases) {
    const { wc, calls } = fakeWebContents()
    runContextAction(wc, item)
    assert.deepEqual(calls, [expected], `${item.id} drove the wrong call`)
  }
})

test('an item with no word attached does nothing rather than replacing with undefined', () => {
  // The `if (item.word)` guards. Without them the spelling arms would call
  // through with undefined, which is the silent-no-op bug the builder tests
  // already guard against from the other side.
  for (const id of ['suggestion', 'addToDictionary'] as const) {
    const { wc, calls } = fakeWebContents()
    runContextAction(wc, { id, label: 'x', enabled: true })
    assert.deepEqual(calls, [], `${id} acted on a missing word`)
  }
})

test('copy link writes the url, and a separator does nothing at all', () => {
  const written = __captureClipboard()
  try {
    const { wc, calls } = fakeWebContents()
    runContextAction(wc, {
      id: 'copyLink',
      label: 'Copy link: https://example.com',
      enabled: true,
      url: 'https://example.com/deep/path'
    })
    assert.deepEqual(written, ['https://example.com/deep/path'])
    assert.deepEqual(calls, [], 'copy link must not touch the page')

    // The default arm. A separator is never clickable, but it reaches the same
    // dispatcher and must not fall through to anything.
    runContextAction(wc, { id: 'separator', label: '', enabled: true })
    assert.deepEqual(written, ['https://example.com/deep/path'])
    assert.deepEqual(calls, [])
  } finally {
    __reset()
  }
})

test('a destroyed page is refused instead of thrown at', () => {
  // The dev server can exit while a preview context menu is still open, which
  // tears the pane's webContents down under it. Every arm below would throw
  // "Object has been destroyed" without the check.
  const dead = destroyedWebContents()
  const items: Array<Parameters<typeof runContextAction>[1]> = [
    { id: 'cut', label: 'Cut', enabled: true },
    { id: 'copy', label: 'Copy', enabled: true },
    { id: 'paste', label: 'Paste', enabled: true },
    { id: 'selectAll', label: 'Select all', enabled: true },
    { id: 'suggestion', label: 'receive', enabled: true, word: 'receive' },
    { id: 'addToDictionary', label: 'Add to dictionary', enabled: true, word: 'gronk' }
  ]
  for (const item of items) {
    assert.doesNotThrow(() => runContextAction(dead, item), `${item.id} reached a destroyed page`)
  }
})

test('copy link still works after the page underneath is gone', () => {
  // Deliberately exempt from the liveness check. The url rides on the item, so
  // this action needs nothing from the page, and a blanket early return would
  // break the one item that still does exactly what it says.
  const written = __captureClipboard()
  try {
    runContextAction(destroyedWebContents(), {
      id: 'copyLink',
      label: 'Copy link: https://example.com',
      enabled: true,
      url: 'https://example.com/still/works'
    })
    assert.deepEqual(written, ['https://example.com/still/works'])
  } finally {
    __reset()
  }
})

test('a right-click with nothing to offer shows no menu, and survives odd params', () => {
  // Reaches installContextMenu: capture the listener it registers, then fire it.
  // This is as far into that function as a test can get, since the next
  // statement after the early return builds a real Menu.
  //
  // Two things at once. The early return, which is why no Menu is constructed
  // and why the stub does not throw. And the params shape: editFlags is read off
  // an event crossing from a renderer that, on the preview pane, is running
  // whatever a dev server served. Dereferenced bare it would throw inside an
  // Electron listener, with nothing to catch it.
  let listener: ((e: unknown, params: unknown) => void) | null = null
  const wc = {
    on: (event: string, fn: (e: unknown, params: unknown) => void) => {
      if (event === 'context-menu') listener = fn
    }
  } as unknown as WebContents

  installContextMenu(wc)
  assert.ok(listener, 'no context-menu listener was registered')

  const fire = listener as unknown as (e: unknown, params: unknown) => void
  assert.doesNotThrow(() => fire({}, { isEditable: false }), 'bare params threw')
  assert.doesNotThrow(() => fire({}, {}), 'empty params threw')
})

test('every enabled item has a label a person can read', () => {
  const menu = buildContextMenu(
    target({
      isEditable: true,
      misspelledWord: 'recieve',
      dictionarySuggestions: ['receive'],
      linkURL: 'https://example.com/page',
      editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
    })
  )
  for (const item of menu) {
    if (item.id === 'separator') continue
    assert.ok(item.label.trim().length > 0, `empty label on ${item.id}`)
  }
})
