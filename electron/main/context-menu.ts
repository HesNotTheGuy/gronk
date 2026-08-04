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
 * variant, which is deliberate. Nothing here navigates or opens anything, so
 * untrusted content in the preview gains no reach it did not already have. An
 * "Open link" item would be a different matter and is exactly why there is not
 * one; a link is copied, never followed.
 *
 * Do not shorten that to "every verb here is local". Paste is not: it moves the
 * user's clipboard INTO the page, which on the preview pane is content the app
 * does not control and which can read what it receives. A page can also set
 * contenteditable, so a right-click anywhere in it offers Paste. That is
 * accepted rather than overlooked. It is user-mediated and identical to pasting
 * into any browser tab, and a preview pane that could not accept a paste would
 * be useless for the thing it exists for. The distinction that actually carries
 * the no-reduced-variant decision is navigation, not locality, and an argument
 * for a new item has to be made on that ground.
 */
export function installContextMenu(wc: WebContents): void {
  wc.on('context-menu', (_event, params) => {
    const items = buildContextMenu({
      isEditable: params.isEditable,
      selectionText: params.selectionText || '',
      misspelledWord: params.misspelledWord || '',
      dictionarySuggestions: params.dictionarySuggestions || [],
      linkURL: params.linkURL || '',
      // Every sibling above defaults a missing value; these were the exception,
      // dereferencing editFlags bare. A throw in here is a throw inside an
      // Electron event listener, which is the same failure class the check in
      // runContextAction exists for, so the flags fail closed to a disabled
      // item rather than trusting the shape of an event on the preview pane.
      editFlags: {
        canCut: params.editFlags?.canCut === true,
        canCopy: params.editFlags?.canCopy === true,
        canPaste: params.editFlags?.canPaste === true,
        canSelectAll: params.editFlags?.canSelectAll === true
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

/**
 * Apply one chosen item. Kept separate so the click handlers stay one line, and
 * exported so the dispatch can be tested without constructing a `Menu`, which is
 * the one thing `node --test` cannot do.
 */
export function runContextAction(wc: WebContents, item: ContextItem): void {
  // The click arrives long after popup() returned, and on the docked preview
  // pane the webContents can be gone by then while the window holding the menu
  // is not. `menu.popup()` takes no window argument, so it belongs to the
  // focused window: for the main window and the popped-out preview that is the
  // same object being torn down, and menu and page die together. The docked
  // WebContentsView is the one that splits. stopPreview() calls
  // `view.webContents.close()` (preview.ts) while hostWindow, which owns the
  // popup, survives, and a dev server exiting calls stopPreview() on its own.
  //
  // Calling into a destroyed WebContents throws "Object has been destroyed".
  // Electron's default handler shows an error dialog rather than exiting, so
  // this is a modal error box and a dead menu item, not the crash it looks
  // like. Still worth refusing quietly.
  //
  // copyLink is exempt because it never touches `wc`: the url rides on the
  // item, so it is the one action that still does exactly what it says after
  // the page underneath has gone.
  if (item.id !== 'copyLink' && wc.isDestroyed()) return

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
