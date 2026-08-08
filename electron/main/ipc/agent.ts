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
import {
  assertCliName,
  assertOneOf,
  assertOptionalAttachments,
  assertPlainObject,
  assertRequestId,
  assertString
} from './validate'
import type { PermissionDecision } from '../../../shared/types'

/** The four the agent understands. Anything else cannot answer a prompt. */
const PERMISSION_DECISIONS: readonly PermissionDecision[] = [
  'allow-once',
  'allow-always',
  'allow-session',
  'reject-once'
]

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
      // Validated because it becomes an argv entry: `-m <model>`. Every other
      // string that reaches the CLI goes through assertCliToken/assertCliName,
      // and this one did not, so a value beginning with '-' could be read by
      // grok as a flag rather than as the model name. The stored setting is
      // checked too, not just the renderer override: the store is a file on
      // disk and is not a trusted input either.
      const rawModel = options?.model ?? settings.model
      const model = rawModel ? assertCliName(rawModel, 'model') : undefined
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

  ipcMain.handle('gronk:send-prompt', (e, text: unknown, options?: unknown) => {
    assertTrustedSender(e)
    if (typeof text !== 'string') throw new Error('Invalid prompt')
    // The cast this replaces proved nothing: the annotation is erased at build
    // time, so `attachments` was whatever arrived. These bytes and paths reach
    // the agent and the transcript.
    const raw = options === undefined || options === null ? {} : assertPlainObject(options, 'options')
    const attachments = assertOptionalAttachments(raw.attachments, 'attachments')
    return agentManager.sendPrompt(text, { attachments })
  })

  ipcMain.handle('gronk:cancel-prompt', async (e) => {
    assertTrustedSender(e)
    return agentManager.cancelPrompt()
  })

  ipcMain.handle('gronk:respond-permission', (e, requestId: unknown, decision: unknown) => {
    assertTrustedSender(e)
    agentManager.respondPermission(
      assertRequestId(requestId, 'requestId'),
      assertOneOf(decision, 'decision', PERMISSION_DECISIONS)
    )
  })

  ipcMain.handle('gronk:get-connection-state', (e) => {
    assertTrustedSender(e)
    return agentManager.getConnectionState()
  })
}
