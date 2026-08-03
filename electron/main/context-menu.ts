/**
 * The right-click menu.
 *
 * Electron ships none. Without an explicit `context-menu` listener a right-click
 * does nothing at all, so the app had no cut, copy or paste, and the spelling
 * suggestions Chromium was already computing were unreachable: the red underline
 * appeared and there was no way to act on it.
 *
 * Spellcheck itself was already on, because `webPreferences.spellcheck` defaults
 * to true and nothing here disables it. That matters for this project's posture:
 * on Windows and Linux the Hunspell dictionaries are fetched from a Google CDN,
 * so if that traffic were unwanted the place to stop it is `spellcheck: false`,
 * not here. This file only surfaces results that already exist.
 *
 * What to show lives in context-menu-items.ts, which is testable.
 */
import { clipboard, Menu, type WebContents } from 'electron'
import { buildContextMenu, type ContextItem } from './context-menu-items'

/**
 * Attach the menu to a webContents.
 *
 * Used for the app's own window AND for the preview pane, with no reduced
 * variant, which is deliberate. Every verb here is local: cut, copy, paste,
 * select and copy-to-clipboard. None of them navigates, opens anything, or hands
 * a string from the page to the OS, so untrusted content in the preview gains
 * nothing from having them. An "Open link" item would be a different matter and
 * is exactly why there is not one; a link is copied, never followed.
 */
export function installContextMenu(wc: WebContents): void {
  wc.on('context-menu', (_event, params) => {
    const items = buildContextMenu({
      isEditable: params.isEditable,
      selectionText: params.selectionText || '',
      misspelledWord: params.misspelledWord || '',
      dictionarySuggestions: params.dictionarySuggestions || [],
      linkURL: params.linkURL || '',
      editFlags: {
        canCut: params.editFlags.canCut,
        canCopy: params.editFlags.canCopy,
        canPaste: params.editFlags.canPaste,
        canSelectAll: params.editFlags.canSelectAll
      }
    })
    if (items.length === 0) return

    const menu = Menu.buildFromTemplate(
      items.map((item) => {
        if (item.id === 'separator') return { type: 'separator' as const }
        return {
          label: item.label,
          enabled: item.enabled,
          click: () => runContextAction(wc, item)
        }
      })
    )
    menu.popup()
  })
}

/** Apply one chosen item. Kept separate so the click handlers stay one line. */
function runContextAction(wc: WebContents, item: ContextItem): void {
  switch (item.id) {
    case 'suggestion':
      if (item.word) wc.replaceMisspelling(item.word)
      return
    case 'addToDictionary':
      if (item.word) wc.session.addWordToSpellCheckerDictionary(item.word)
      return
    case 'cut':
      wc.cut()
      return
    case 'copy':
      wc.copy()
      return
    case 'paste':
      wc.paste()
      return
    case 'selectAll':
      wc.selectAll()
      return
    case 'copyLink':
      // Written to the clipboard, never opened. In the preview pane this string
      // comes from the user's dev server, so following it would hand an
      // untrusted page a navigation; putting it on the clipboard hands the
      // decision to the person reading it.
      if (item.url) clipboard.writeText(item.url)
      return
    default:
      return
  }
}
