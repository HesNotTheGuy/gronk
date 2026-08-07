/**
 * Working-tree changes for the folder the agent has open. Local git only: no
 * network, no forge, no credential, and nothing persisted.
 *
 * The cwd is never taken from the renderer. It comes from the agent manager, so
 * this cannot be pointed at another directory by asking nicely, and a null cwd
 * is a refusal rather than a fallback.
 *
 * The hardening that makes running git in an untrusted repository safe lives in
 * ../git-diff.ts and applies to every invocation there.
 */

import { ipcMain } from 'electron'
import { agentManager } from '../agent-manager'
import { fileDiff, workingTreeChanges } from '../git-diff'
import { assertTrustedSender } from '../ipc-guard'
import { assertString } from './validate'

export function registerGitIpc(): void {
  ipcMain.handle('gronk:git-changes', (e) => {
    assertTrustedSender(e)
    return workingTreeChanges(agentManager.getCwd())
  })

  ipcMain.handle('gronk:git-file-diff', (e, filePath: unknown) => {
    assertTrustedSender(e)
    // The path is validated, resolved against the agent's folder and refused if
    // it lands outside; it reaches git only after a literal `--`, so it cannot
    // arrive as a flag.
    //
    // The status is NOT taken from the renderer. It decides which branch runs,
    // and one of those branches reads bytes off the disk, so it is re-derived
    // from git inside fileDiff.
    return fileDiff(agentManager.getCwd(), assertString(filePath, 'path'))
  })
}
