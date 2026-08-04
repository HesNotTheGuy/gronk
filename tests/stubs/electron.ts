/**
 * Minimal stand-in for the `electron` module so main-process code can be loaded
 * by `node --test`. Wired up in tests/ts-loader.mjs, which rewrites a bare
 * `electron` import to this file.
 *
 * Only what the modules under test actually touch is implemented. Anything else
 * throws loudly rather than silently returning undefined — a test that trips one
 * of these is reaching further into Electron than it should, and the right fix is
 * usually to extract the pure logic (see ipc-guard.ts, plugins-map.ts).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const paths = new Map<string, string>()

/** Point app.getPath(name) at a scratch directory. Call from a test's setup. */
export function __setPath(name: string, dir: string): void {
  paths.set(name, dir)
}

/** Fresh temp dir for `userData`, so store tests never touch real app data. */
export function __freshUserData(prefix = 'gronk-test-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  paths.set('userData', dir)
  return dir
}

/**
 * Collected clipboard writes while capture is on, or null when it is off.
 * Off is the default, so an accidental clipboard write still fails loudly.
 */
let clipboardWrites: string[] | null = null

/**
 * Let this test read what was written to the clipboard instead of refusing.
 *
 * Opt-in rather than always-on: a recording clipboard that never refuses would
 * turn "this code path touched the real clipboard" from a loud failure into a
 * silent pass for every other test in the suite. `__reset()` puts the refusal
 * back.
 */
export function __captureClipboard(): string[] {
  clipboardWrites = []
  return clipboardWrites
}

export function __reset(): void {
  paths.clear()
  clipboardWrites = null
}

export const app = {
  getPath(name: string): string {
    const dir = paths.get(name)
    if (!dir) {
      throw new Error(
        `electron stub: app.getPath(${JSON.stringify(name)}) was not configured — ` +
          'call __freshUserData() or __setPath() first'
      )
    }
    return dir
  },
  getName: () => 'Gronk',
  getVersion: () => '0.0.0-test',
  requestSingleInstanceLock: () => true,
  quit: () => {},
  whenReady: () => Promise.resolve(),
  on: () => {}
}

function unsupported(name: string): never {
  throw new Error(`electron stub: ${name} is not available under node --test`)
}

export const BrowserWindow = {
  getAllWindows: () => [] as unknown[],
  fromWebContents: () => null
}
export const ipcMain = {
  handle: () => unsupported('ipcMain.handle'),
  on: () => unsupported('ipcMain.on')
}
export const dialog = { showOpenDialog: () => unsupported('dialog.showOpenDialog') }
export const shell = { openExternal: () => unsupported('shell.openExternal') }
export const session = { defaultSession: null }
/**
 * Both are imported at module scope by context-menu.ts, so they have to exist
 * for anything importing it to link at all: preview.ts reaches them
 * transitively, and tests/preview-url.test.ts dies before its first assertion
 * without them. tests/context-menu.test.ts now imports that module directly.
 *
 * `Menu` still throws unconditionally. A test that reaches it is trying to open
 * a real menu, and there is no version of that which works under `node --test`.
 * `clipboard.writeText` throws too unless a test has called
 * `__captureClipboard()`, which is how the copy-link action is exercised without
 * either touching the real clipboard or quietly doing nothing.
 */
export const Menu = {
  buildFromTemplate: () => unsupported('Menu.buildFromTemplate'),
  setApplicationMenu: () => unsupported('Menu.setApplicationMenu')
}
export const clipboard = {
  writeText: (text: string): void => {
    if (clipboardWrites === null) unsupported('clipboard.writeText')
    clipboardWrites.push(text)
  }
}
/** Present so main-process code can import Notification; tests never show toasts. */
export class Notification {
  static isSupported(): boolean {
    return false
  }
  constructor(_opts?: { title?: string; body?: string; silent?: boolean }) {}
  on(_event: string, _handler: () => void): void {}
  show(): void {}
}
export const WebContentsView = class {
  constructor() {
    unsupported('new WebContentsView()')
  }
}

export default {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  session,
  Menu,
  clipboard,
  Notification,
  WebContentsView
}
