/**
 * Pure argv construction for `grok agent stdio`.
 *
 * Deliberately free of Electron and child_process imports so the security-critical
 * logic here (permission-mode emission, YOLO downgrades, flag ordering) can be
 * covered by `npm test` without booting an app. `agent-manager.ts` owns the process
 * spawning and mirrors the derived values this returns onto the AgentManager.
 *
 * Security rules (do not weaken):
 * - `--permission-mode` is ALWAYS emitted, including for 'default'. Omitting it
 *   silently hands permission policy to the user's config file (see the comment on
 *   the push below).
 * - `alwaysApprove` and `bypassPermissions` are refused unless an acknowledgement
 *   is already persisted. `store.setSettings` enforces the same rule; repeating it
 *   here is defence in depth for callers that pass a per-start override.
 * - Derivation happens exactly once, here. Callers must consume the returned
 *   `permissionMode` / `alwaysApprove` rather than re-deriving them.
 */

import type { PermissionMode } from '../../shared/types'

/** Conversational-Grok persona for the Chat surface (grok.com / Grok on X style). */
export const CHAT_SYSTEM_PROMPT = [
  'You are Grok, built by xAI.',
  'You are in Grocky desktop Chat mode — a general conversation like grok.com or Grok on X.',
  'Be helpful, witty when appropriate, and clear.',
  'Answer directly. Do not browse or edit the local filesystem unless the user explicitly asks.',
  'You may use web search when current information helps.',
  'You are not limited to coding topics.'
].join(' ')

/** Chat-surface guard rails, passed as `--rules`. */
export const CHAT_RULES =
  'Chat mode: prefer direct answers over tool-heavy exploration. Never modify files unless asked.'

export interface BuildAgentArgsOptions {
  /** Requested mode — `settings.permissionMode` or a per-start override. Falsy means 'default'. */
  permissionMode?: PermissionMode
  /** Requested YOLO — `settings.alwaysApprove` or a per-start override. */
  alwaysApprove?: boolean
  /** `settings.alwaysApproveAck`: the user acknowledged the YOLO risk on this install. */
  alwaysApproveAck?: boolean
  /** Resolved model id. Falsy leaves model selection to the CLI. */
  model?: string
  /** Booting surface. Anything other than 'chat' is treated as 'project'. */
  surface?: 'chat' | 'project'
}

export interface AgentArgs {
  /** argv for the grok binary, in the order grok requires. */
  args: string[]
  /** The mode actually handed to the CLI, after ack downgrades. */
  permissionMode: PermissionMode
  /** YOLO after the ack downgrade. AgentManager mirrors this onto itself. */
  alwaysApprove: boolean
  /** Normalized surface. */
  surface: 'chat' | 'project'
}

/**
 * Build the argv for one `grok agent stdio` boot, plus the permission values the
 * caller must adopt.
 *
 * Ordering is not cosmetic: grok only accepts global flags before the `agent`
 * subcommand, and `-m` / `--always-approve` only after it. `stdio` is always last.
 */
export function buildAgentArgs(options: BuildAgentArgsOptions): AgentArgs {
  const ack = !!options.alwaysApproveAck

  // Hard safety: store may refuse alwaysApprove without ack
  let alwaysApprove = !!options.alwaysApprove
  if (alwaysApprove && !ack) {
    alwaysApprove = false
  }

  // permission-mode is a top-level grok flag (before `agent` subcommand)
  let permissionMode: PermissionMode = options.permissionMode || 'default'
  if (alwaysApprove) {
    permissionMode = 'bypassPermissions'
  } else if (permissionMode === 'bypassPermissions' && !ack) {
    permissionMode = 'default'
  }

  const surface = options.surface === 'chat' ? 'chat' : 'project'
  const model = options.model

  // Global flags before `agent` subcommand
  const args: string[] = []
  // ALWAYS pass the mode, including 'default'. Omitting it lets the CLI fall back to
  // ~/.grok/config.toml `permission_mode` (commonly "auto"), which silently auto-approves
  // every tool while Grocky's UI still shows the gated Default mode. Verified against
  // grok 0.2.111: no flag => 0 permission requests; `--permission-mode default` => prompts.
  args.push('--permission-mode', permissionMode || 'default')
  if (surface === 'chat') {
    // Conversational Grok (website/X-style) — still CLI-backed, not a web wrap
    args.push('--system-prompt-override', CHAT_SYSTEM_PROMPT)
    args.push('--rules', CHAT_RULES)
  }
  args.push('agent')
  if (model) {
    args.push('-m', model)
  }
  if (alwaysApprove || permissionMode === 'bypassPermissions') {
    args.push('--always-approve')
  }
  args.push('stdio')

  return { args, permissionMode, alwaysApprove, surface }
}
