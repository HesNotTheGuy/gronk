/**
 * Preview pane IPC: start/stop the dev server, position the embedded view and
 * drive its URL. The view itself is owned by ../preview.ts, which index.ts
 * binds to the window at creation time.
 */

import { ipcMain } from 'electron'
import { assertTrustedSender } from '../ipc-guard'
import {
  getPreviewStatus,
  reloadPreview,
  setPreviewBounds,
  setPreviewUrl,
  startPreview,
  stopPreview
} from '../preview'
import { normalizeCwd } from '../store'
import { assertOptionalString, assertString } from './validate'

export function registerPreviewIpc(): void {
  ipcMain.handle('gronk:preview-start', (e, cwd: string, command?: string) => {
    assertTrustedSender(e)
    return startPreview(normalizeCwd(assertString(cwd, 'cwd')), assertOptionalString(command, 'command'))
  })

  ipcMain.handle('gronk:preview-stop', (e) => {
    assertTrustedSender(e)
    stopPreview()
  })

  ipcMain.handle('gronk:preview-set-bounds', (e, rect: unknown) => {
    assertTrustedSender(e)
    if (rect && typeof rect === 'object') {
      const r = rect as { x?: number; y?: number; width?: number; height?: number }
      if (
        typeof r.x === 'number' &&
        typeof r.y === 'number' &&
        typeof r.width === 'number' &&
        typeof r.height === 'number'
      ) {
        setPreviewBounds({ x: r.x, y: r.y, width: r.width, height: r.height })
      }
    }
  })

  ipcMain.handle('gronk:preview-set-url', (e, url: string) => {
    assertTrustedSender(e)
    setPreviewUrl(assertString(url, 'url'))
  })

  ipcMain.handle('gronk:preview-reload', (e) => {
    assertTrustedSender(e)
    reloadPreview()
  })

  ipcMain.handle('gronk:preview-status', (e) => {
    assertTrustedSender(e)
    return getPreviewStatus()
  })
}
