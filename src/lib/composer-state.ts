import type { ConnectionState } from '../../shared/types'

/**
 * What the composer permits at each connection state.
 *
 * Extracted for the same reason as scroll-stick.ts and session-nav.ts: the suite
 * is `node --test` with no DOM, so a rule spread across six `disabled={...}`
 * props cannot be mutation-checked where it lives.
 *
 * THE DECISION THIS FILE EXISTS TO MAKE EXPLICIT: typing and sending are
 * different acts, and only one of them needs the agent.
 *
 * A single `disabled={connection !== 'ready'}` reached the textarea, the model
 * picker, the permission-mode picker, Attach and Send alike. So restoring a
 * session switched the keyboard off, and the thing that felt broken about
 * reopening a session was not slowness at all: the box was deliberately dead.
 *
 * Composing while a session restores is safe. The text goes nowhere until Send,
 * and Send stays gated. The others are not safe and stay gated with it:
 *
 * - Send needs somewhere to send to.
 * - Attach reads files for a prompt that cannot be submitted yet.
 * - Model and permission mode are not preferences, they are agent boot
 *   arguments. Switching model restarts the agent, and changing permission mode
 *   rewrites the argv the CLI is being launched with. Both, mid-restore, race
 *   the boot they would be reconfiguring.
 *
 * The one state where typing is still off is `idle`: no session open and none
 * opening, so there is nothing to compose against and the placeholder is the
 * only thing telling the user to sign in or pick a session.
 *
 * The other five states all allow typing, and two of them are the reason this is
 * expressed as "not idle" rather than a list. `error` and `stopped` mean the
 * agent is down, and someone whose session just failed is exactly the person
 * composing a message while they decide whether to retry. Send stays off there
 * because there is nothing to send to.
 */
export interface ComposerPermissions {
  /** The textarea. */
  canType: boolean
  /** The Send button, and the submit path behind it. */
  canSend: boolean
  /** Attach: reads files off disk for a prompt that cannot go yet. */
  canAttach: boolean
  /** Model and permission mode: agent boot arguments, not preferences. */
  canChangeAgentSettings: boolean
}

export interface ComposerStateInput {
  connection: ConnectionState
  /** The renderer's own restore flag: a transcript is being put on screen. */
  hydrating: boolean
  /** A turn is in flight. */
  busy: boolean
  /** Is there anything to send. */
  hasContent: boolean
}

export function composerPermissions({
  connection,
  hydrating,
  busy,
  hasContent
}: ComposerStateInput): ComposerPermissions {
  // `hydrating` counts as somewhere to type even if the connection has not
  // moved off idle yet: restore sets it before the agent starts booting, and
  // that gap is exactly the window the user is trying to type in.
  const haveSomewhereToType = connection !== 'idle' || hydrating
  const agentReady = connection === 'ready' && !hydrating

  return {
    canType: haveSomewhereToType,
    canSend: agentReady && !busy && hasContent,
    canAttach: agentReady,
    canChangeAgentSettings: agentReady
  }
}

/**
 * What the empty composer should say.
 *
 * Split from the flags because the placeholder is the only feedback a user gets
 * for why Send is grey while the box accepts text. "Restoring" has to be said,
 * or the composer looks broken in a new way instead of the old one.
 */
export function composerPlaceholder(
  perms: ComposerPermissions,
  input: { hydrating: boolean; cwd: string | null }
): string {
  if (!perms.canType) return 'Sign in and open Chat or a Project…'
  if (input.hydrating || !perms.canSend) {
    if (input.hydrating) return 'Restoring the session… you can start typing'
  }
  return input.cwd
    ? 'Message the project agent  ·  @ files  ·  paste images  ·  Enter send'
    : 'Message Grok  ·  paste images  ·  Enter send'
}
