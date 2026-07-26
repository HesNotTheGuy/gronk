import type { BrowserWindow } from 'electron'

/**
 * The only thing the IPC modules are allowed to know about index.ts.
 *
 * The window is fetched per call rather than captured at registration time:
 * handlers are registered once at app-ready, but the window is torn down on
 * close and rebuilt by the macOS 'activate' handler, so a reference captured
 * during registration would point at a destroyed window after the first close.
 */
export interface IpcContext {
  getMainWindow(): BrowserWindow | null
}
