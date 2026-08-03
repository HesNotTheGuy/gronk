/**
 * What the right-click menu should contain, given what was right-clicked.
 *
 * Separate from context-menu.ts, which does the showing, because `Menu` and
 * `clipboard` cannot be imported under `node --test`: the Electron stub does
 * not export them, and a top-level import of either makes this whole module
 * unloadable in a test. The decision has branches worth pinning; the showing has
 * none. Same split as ipc-guard.ts and plugins-map.ts.
 */

/** The fields of Electron's ContextMenuParams this actually reads. */
export interface ContextTarget {
  isEditable: boolean
  selectionText: string
  misspelledWord: string
  dictionarySuggestions: string[]
  linkURL: string
  editFlags: {
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
  }
}

export type ContextItemId =
  | 'separator'
  | 'suggestion'
  | 'addToDictionary'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'copyLink'

export interface ContextItem {
  id: ContextItemId
  label: string
  enabled: boolean
  /** The replacement, for a spelling suggestion. */
  word?: string
  /** The address, for copyLink. */
  url?: string
}

/**
 * At most this many spellings. Chromium can return a long list and a menu that
 * runs off the screen is worse than one that omits the eighth-best guess.
 */
const MAX_SUGGESTIONS = 5

/** A link label long enough to read, short enough not to stretch the menu. */
const MAX_LINK_LABEL = 60

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * Decide the menu for a right-click. Returns [] when there is nothing useful to
 * offer, and the caller shows no menu at all rather than an empty box.
 *
 * Enablement comes from `editFlags`, which Chromium computes for the actual
 * target, rather than from guessing. Offering Paste on a read-only field, or Cut
 * with no selection, is how a menu teaches people not to trust it.
 */
export function buildContextMenu(target: ContextTarget): ContextItem[] {
  const items: ContextItem[] = []
  const flags = target.editFlags

  // Spellings first: when the user right-clicks a red underline, the correction
  // is the thing they came for and it should not be below Cut.
  if (target.isEditable && target.misspelledWord) {
    for (const word of target.dictionarySuggestions.slice(0, MAX_SUGGESTIONS)) {
      items.push({ id: 'suggestion', label: word, enabled: true, word })
    }
    if (items.length === 0) {
      // Chromium knows it is misspelled but has nothing to propose. Saying so is
      // better than a menu that silently omits the reason it was opened.
      items.push({ id: 'suggestion', label: 'No suggestions', enabled: false })
    }
    // The word rides on the item. Reading it from the event later would mean
    // trusting that nothing changed between the right-click and the click.
    items.push({
      id: 'addToDictionary',
      label: 'Add to dictionary',
      enabled: true,
      word: target.misspelledWord
    })
    items.push({ id: 'separator', label: '', enabled: true })
  }

  if (target.isEditable) {
    items.push({ id: 'cut', label: 'Cut', enabled: flags.canCut })
    items.push({ id: 'copy', label: 'Copy', enabled: flags.canCopy })
    items.push({ id: 'paste', label: 'Paste', enabled: flags.canPaste })
    items.push({ id: 'separator', label: '', enabled: true })
    items.push({ id: 'selectAll', label: 'Select all', enabled: flags.canSelectAll })
  } else if (target.selectionText.trim()) {
    // Read-only text: copying is the only sensible verb. Select All on a whole
    // transcript selects the chrome around it too, which is never what is meant.
    items.push({ id: 'copy', label: 'Copy', enabled: flags.canCopy })
  }

  if (target.linkURL) {
    if (items.length) items.push({ id: 'separator', label: '', enabled: true })
    items.push({
      id: 'copyLink',
      label: `Copy link: ${truncate(target.linkURL, MAX_LINK_LABEL)}`,
      enabled: true,
      url: target.linkURL
    })
  }

  return trimSeparators(items)
}

/**
 * Drop leading, trailing and doubled separators.
 *
 * Each block above adds its own divider without knowing whether anything
 * follows, which is what keeps them independent. The cost is a menu that can end
 * in a line with nothing under it, so the tidying happens once, here.
 */
function trimSeparators(items: ContextItem[]): ContextItem[] {
  const out: ContextItem[] = []
  for (const item of items) {
    if (item.id !== 'separator') {
      out.push(item)
      continue
    }
    if (out.length === 0) continue
    if (out[out.length - 1].id === 'separator') continue
    out.push(item)
  }
  while (out.length && out[out.length - 1].id === 'separator') out.pop()
  return out
}
