/**
 * Where Gronk keeps its data, and whether that store is healthy.
 *
 * The move itself lives in data-dir.ts (copy → verify → remove). These
 * handlers only validate the request and refuse it while an agent is live.
 */

import { dialog, ipcMain } from 'electron'
import { agentManager } from '../agent-manager'
import { getDataLocation, moveDataDir, resetDataDir } from '../data-dir'
import { assertTrustedSender } from '../ipc-guard'
import { getStoreHealth } from '../store'
import { assertString } from './validate'
import type { IpcContext } from './context'
import type { MoveDataResult } from '../../../shared/types'

/**
 * Non-null when a data-directory move must be refused.
 *
 * The agent child process runs with the chat sandbox as its cwd and streams into
 * the transcript store, so copying those files out from under it corrupts them.
 * The agent is NOT stopped here: that would discard a running conversation
 * without asking. The user stops it, then retries.
 *
 * 'error' / 'stopped' / 'idle' are deliberately not blocked — the child is gone
 * in those states, and refusing there would strand a user whose agent crashed
 * with no way to move their data back.
 */
function dataMoveRefusal(): MoveDataResult | null {
  const state = agentManager.getConnectionState()
  if (state !== 'starting' && state !== 'ready' && state !== 'loading') return null
  return {
    ok: false,
    message:
      'An agent is still running. Stop the current Chat or Build session first — ' +
      'moving files while the agent has them open would corrupt your transcripts.',
    location: getDataLocation()
  }
}

export function registerDataLocationIpc(ctx: IpcContext): void {
  ipcMain.handle('gronk:get-store-health', (e) => {
    assertTrustedSender(e)
    return getStoreHealth()
  })

  ipcMain.handle('gronk:get-data-location', (e) => {
    assertTrustedSender(e)
    return getDataLocation()
  })

  ipcMain.handle('gronk:choose-data-dir', async (e) => {
    assertTrustedSender(e)
    const result = await dialog.showOpenDialog(ctx.getMainWindow()!, {
      title: 'Choose a folder for Gronk data',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    return result.filePaths[0]
  })

  ipcMain.handle('gronk:move-data-dir', async (e, target: unknown) => {
    assertTrustedSender(e)
    const dir = assertString(target, 'target')
    const refusal = dataMoveRefusal()
    if (refusal) return refusal
    return moveDataDir(dir)
  })

  ipcMain.handle('gronk:reset-data-dir', async (e) => {
    assertTrustedSender(e)
    // Same file operations as a move, so the same running-agent rule applies.
    const refusal = dataMoveRefusal()
    if (refusal) return refusal
    return resetDataDir()
  })
}
