/**
 * What a session is doing, and whose events reach the renderer.
 *
 * Both decisions live here rather than inside the registry because nothing in
 * the test suite can construct an `AgentManager` — it owns a CLI child process.
 * Left as methods they would be the only untested part of the feature, which is
 * how the visible half of this change could ship broken while every test passed.
 */

import type { ConnectionState, MainToRendererEvent, SessionLiveness } from '../../../shared/types'

/**
 * The three answers a sidebar row can give.
 *
 * `blocked` beats `working` deliberately. A session waiting on a permission has
 * a turn open, so by the raw facts it is working — and from outside those two
 * look identical. Only one of them needs a person, and that is the whole reason
 * the indicator has more than one state.
 *
 * `null` means not live: a session that is idle in the connection sense, not
 * one that is up with nothing to do.
 */
export function livenessOf(input: {
  state: ConnectionState
  hasPendingPermission: boolean
  hasOpenTurn: boolean
}): SessionLiveness | null {
  if (input.state !== 'ready' && input.state !== 'loading') return null
  if (input.hasPendingPermission) return 'blocked'
  return input.hasOpenTurn ? 'working' : 'idle'
}

/**
 * May this session's event go to the renderer?
 *
 * Everything except `connection` already names its session, and the renderer
 * drops what does not belong to the conversation on screen, so it is forwarded
 * and the renderer decides.
 *
 * `connection` is the exception, and the reason is narrow: it is the one event
 * that legitimately arrives with no session id, because a session id does not
 * exist until the agent has booted. The renderer accepts an unattributed one
 * unconditionally, since during a switch that is the only thing it can do. So a
 * second agent booting in the background would drive the watched session's
 * composer to `starting` and disable it. Only something holding every session
 * can tell those apart, which is why this is not a renderer rule.
 */
export function mayForward(event: MainToRendererEvent, isForeground: boolean): boolean {
  if (event.type !== 'connection') return true
  return isForeground
}
