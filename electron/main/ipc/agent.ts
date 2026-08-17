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
  assertOptionalString,
  assertPlainObject,
  assertRequestId,
  assertString
} from './validate'
import { REASONING_EFFORTS, type PermissionDecision } from '../../../shared/types'

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
        reasoningEffort?: string
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
      // Closed set rather than assertCliName: the CLI does not validate this flag's
      // value at all, so an unrecognised one would reach the child unchallenged. The
      // stored setting is checked too — the store is a file on disk, not a trusted input.
      const rawEffort = options?.reasoningEffort ?? settings.reasoningEffort
      const reasoningEffort = rawEffort
        ? assertOneOf(rawEffort, 'reasoningEffort', REASONING_EFFORTS)
        : undefined
      // Forward the override as-is. Substituting settings.alwaysApprove here would
      // re-derive the stored posture in a second place; agent-manager folds an
      // absent override against the store itself via requestedPermissionMode.
      const alwaysApprove = options?.alwaysApprove

      // Reuse now means "is a session for this folder already live", which the
      // registry answers because it holds all of them. Nothing is stopped to
      // make room: a session the user walked away from goes on working.
      return agentManager.start(normalized, {
        model,
        reasoningEffort,
        alwaysApprove,
        surface,
        forceNew: options?.forceNew === true
      })
    }
  )

  ipcMain.handle('gronk:stop-agent', async (e, sessionId?: unknown) => {
    assertTrustedSender(e)
    // Named to stop a session without opening it; unnamed still means the one
    // on screen, which is what every existing caller intends.
    return agentManager.stop(assertOptionalString(sessionId, 'sessionId') ?? null)
  })

  ipcMain.handle('gronk:focus-session', (e, sessionId?: unknown) => {
    assertTrustedSender(e)
    agentManager.focus(assertOptionalString(sessionId, 'sessionId') ?? null)
  })

  ipcMain.handle('gronk:get-session-liveness', (e) => {
    assertTrustedSender(e)
    return agentManager.getLiveness()
  })

  ipcMain.handle('gronk:send-prompt', (e, text: unknown, options?: unknown) => {
    assertTrustedSender(e)
    if (typeof text !== 'string') throw new Error('Invalid prompt')
    // The cast this replaces proved nothing: the annotation is erased at build
    // time, so `attachments` was whatever arrived. These bytes and paths reach
    // the agent and the transcript.
    const raw = options === undefined || options === null ? {} : assertPlainObject(options, 'options')
    const attachments = assertOptionalAttachments(raw.attachments, 'attachments')
    const sessionId = assertOptionalString(raw.sessionId, 'sessionId')
    return agentManager.sendPrompt(text, { attachments }, sessionId ?? null)
  })

  /**
   * Change the model on a running session without restarting it.
   *
   * Validated with `assertCliName`, the same validator `gronk:start-agent` puts on the
   * same value. This one reaches the CLI as a JSON field rather than an argv entry, so a
   * leading dash cannot be read as a flag here — but the two paths carry the same string
   * to the same program, and letting them disagree about what a model name may contain
   * is how the argv path quietly becomes the lenient one later.
   */
  ipcMain.handle('gronk:set-model', async (e, model: unknown, sessionId?: unknown) => {
    assertTrustedSender(e)
    return agentManager.setModel(
      assertCliName(model, 'model'),
      assertOptionalString(sessionId, 'sessionId') ?? null
    )
  })

  ipcMain.handle('gronk:cancel-prompt', async (e, sessionId?: unknown) => {
    assertTrustedSender(e)
    return agentManager.cancelPrompt(assertOptionalString(sessionId, 'sessionId') ?? null)
  })

  ipcMain.handle(
    'gronk:respond-permission',
    (e, requestId: unknown, decision: unknown, sessionId?: unknown) => {
      assertTrustedSender(e)
      // The session is part of the address, not a hint. Request ids are chosen
      // by each CLI child and start at one, so two live sessions use the same
      // small integers and the id alone names two different requests.
      agentManager.respondPermission(
        assertRequestId(requestId, 'requestId'),
        assertOneOf(decision, 'decision', PERMISSION_DECISIONS),
        assertOptionalString(sessionId, 'sessionId') ?? null
      )
    }
  )

  ipcMain.handle('gronk:get-connection-state', (e) => {
    assertTrustedSender(e)
    return agentManager.getConnectionState()
  })
}
