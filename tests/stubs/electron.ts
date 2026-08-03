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

export function __reset(): void {
  paths.clear()
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
 * Reached transitively, not directly: preview.ts imports the context menu, which
 * imports both of these at module scope. Without them the whole of preview.ts
 * fails to link and tests/preview-url.test.ts dies before its first assertion.
 *
 * They still throw when called. Loading is all a test needs; anything that
 * actually invokes them is trying to open a real menu or touch the real
 * clipboard, and should fail loudly rather than quietly do nothing.
 */
export const Menu = {
  buildFromTemplate: () => unsupported('Menu.buildFromTemplate'),
  setApplicationMenu: () => unsupported('Menu.setApplicationMenu')
}
export const clipboard = { writeText: () => unsupported('clipboard.writeText') }
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
