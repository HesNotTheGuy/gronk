/**
 * Filesystem-facing IPC: native pickers, project file listing, and reading or
 * revealing local images. Every path the renderer supplies is re-validated here
 * or in ./images.ts — none of these handlers trust a path as given.
 */

import { dialog, ipcMain } from 'electron'
import { agentManager } from '../agent-manager'
import { listProjectFiles } from '../fs-utils'
import { assertTrustedSender } from '../ipc-guard'
import { normalizeCwd } from '../store'
import { readLocalImageSafe, revealLocalPathSafe } from './images'
import { assertOptionalString, assertString } from './validate'
import type { IpcContext } from './context'

export function registerFilesIpc(ctx: IpcContext): void {
  ipcMain.handle('gronk:select-folder', async (e) => {
    assertTrustedSender(e)
    const result = await dialog.showOpenDialog(ctx.getMainWindow()!, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle(
    'gronk:select-file',
    async (
      e,
      options?: { filters?: { name: string; extensions: string[] }[]; title?: string }
    ) => {
      assertTrustedSender(e)
      const result = await dialog.showOpenDialog(ctx.getMainWindow()!, {
        title: options?.title || 'Select file',
        properties: ['openFile'],
        filters: options?.filters
      })
      if (result.canceled || !result.filePaths[0]) return null
      return result.filePaths[0]
    }
  )

  ipcMain.handle(
    'gronk:list-project-files',
    (e, cwd: string, query?: string, limit?: number) => {
      assertTrustedSender(e)
      const root = assertString(cwd, 'cwd')
      // FIX-13: only allow listing under the active agent project when one is open
      const active = agentManager.getCwd()
      if (active) {
        const nRoot = normalizeCwd(root)
        const nActive = normalizeCwd(active)
        if (nRoot !== nActive && !nRoot.startsWith(nActive + '/')) {
          throw new Error('listProjectFiles restricted to the open project')
        }
      }
      const q = assertOptionalString(query, 'query')
      const lim =
        typeof limit === 'number' && Number.isFinite(limit)
          ? Math.min(Math.max(1, Math.floor(limit)), 100)
          : 40
      return listProjectFiles(root, q, lim)
    }
  )

  ipcMain.handle('gronk:read-local-image', async (e, filePath: string) => {
    assertTrustedSender(e)
    return readLocalImageSafe(assertString(filePath, 'filePath'))
  })

  ipcMain.handle('gronk:reveal-local-path', async (e, filePath: string) => {
    assertTrustedSender(e)
    return revealLocalPathSafe(assertString(filePath, 'filePath'))
  })
}
