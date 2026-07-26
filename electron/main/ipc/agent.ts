/**
 * Agent lifecycle IPC: starting and stopping the CLI child, sending prompts,
 * cancelling them, and answering its permission requests.
 */

import { ipcMain } from 'electron'
import { agentManager } from '../agent-manager'
import { getAuthStatus } from '../auth'
import { assertTrustedSender } from '../ipc-guard'
import { addRecentProject, getSettings, normalizeCwd } from '../store'
import { isChatWorkspace } from '../../../shared/path'
import { assertString } from './validate'
import type {
  PermissionDecision,
  PromptAttachment,
  SendPromptOptions
} from '../../../shared/types'

export function registerAgentIpc(): void {
  ipcMain.handle(
    'gronk:start-agent',
    async (
      e,
      cwd: string,
      options?: {
        model?: string
        alwaysApprove?: boolean
        forceNew?: boolean
        surface?: 'chat' | 'project'
      }
    ) => {
      assertTrustedSender(e)
      const auth = await getAuthStatus()
      if (!auth.authenticated) {
        throw new Error(
          auth.message ||
            'Sign in required. Use your own Grok account before chatting or opening a project.'
        )
      }

      const normalized = normalizeCwd(assertString(cwd, 'cwd'))
      // Path is authoritative: chat-workspace is always app Chat, never Workspace
      const surface =
        options?.surface === 'chat' || isChatWorkspace(normalized, null)
          ? 'chat'
          : 'project'
      // Chat sandbox must never appear under Workspace folders
      if (surface === 'project') {
        addRecentProject(normalized)
      }
      const settings = getSettings()
      const model = options?.model ?? settings.model
      // Forward the override as-is. Substituting settings.alwaysApprove here would
      // re-derive the stored posture in a second place; agent-manager folds an
      // absent override against the store itself via requestedPermissionMode.
      const alwaysApprove = options?.alwaysApprove

      if (
        !options?.forceNew &&
        agentManager.getConnectionState() === 'ready' &&
        agentManager.getCwd() &&
        normalizeCwd(agentManager.getCwd()!) === normalized &&
        agentManager.getSessionId() &&
        agentManager.getSurface() === surface &&
        (!model || model === agentManager.getCurrentModel())
      ) {
        return { sessionId: agentManager.getSessionId()! }
      }

      return agentManager.start(normalized, { model, alwaysApprove, surface })
    }
  )

  ipcMain.handle('gronk:stop-agent', async (e) => {
    assertTrustedSender(e)
    return agentManager.stop()
  })

  ipcMain.handle(
    'gronk:send-prompt',
    (e, text: string, options?: SendPromptOptions) => {
      assertTrustedSender(e)
      if (typeof text !== 'string') throw new Error('Invalid prompt')
      return agentManager.sendPrompt(text, options as { attachments?: PromptAttachment[] })
    }
  )

  ipcMain.handle('gronk:cancel-prompt', async (e) => {
    assertTrustedSender(e)
    return agentManager.cancelPrompt()
  })

  ipcMain.handle(
    'gronk:respond-permission',
    (e, requestId: number | string, decision: PermissionDecision) => {
      assertTrustedSender(e)
      if (requestId === undefined || requestId === null) throw new Error('Invalid requestId')
      if (!['allow-once', 'allow-always', 'reject-once'].includes(decision)) {
        throw new Error('Invalid permission decision')
      }
      agentManager.respondPermission(requestId, decision)
    }
  )

  ipcMain.handle('gronk:get-connection-state', (e) => {
    assertTrustedSender(e)
    return agentManager.getConnectionState()
  })
}
