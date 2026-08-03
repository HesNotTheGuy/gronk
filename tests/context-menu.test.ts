import test from 'node:test'
import assert from 'node:assert/strict'
import { buildContextMenu, type ContextTarget } from '../electron/main/context-menu-items'

/**
 * What the right-click menu offers, given what was clicked.
 *
 * The decision lives in a pure function precisely so it can be tested: `Menu`
 * cannot be constructed under `node --test`, and a menu whose contents are
 * decided inside the Electron callback would be unreachable here. Only the
 * showing of it is untested, which is the part with no branches.
 *
 * The failure this guards against is a menu that offers an action the target
 * cannot perform. Paste on a read-only field, or Cut with nothing selected, is
 * how a menu teaches people to stop trusting it.
 */

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
  assert.ok(link.label.length < 80, `label was ${link.label.length} chars`)
  assert.ok(link.label.endsWith('…'))
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
