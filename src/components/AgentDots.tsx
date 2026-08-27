import { useMemo } from 'react'
import type { ToolCallInfo } from '../../shared/types'
import { extractAgentUnits } from '../lib/agent-activity'
import { agentDots } from '../lib/agent-dots'

/**
 * The glance layer: one dot per agent unit a message spawned.
 *
 * Renders nothing at all when a message spawned no agents, which is most of
 * them, so the common message gains no height. What it replaced was a wrapping
 * grid of bordered chips that every message with more than one tool call paid
 * for, whether or not anything interesting had happened.
 *
 * This is the glance, not the detail. The full list is still one click away
 * inside ToolActivity, and nothing here is clickable: a dot is 6px, which is
 * too small to be an honest target, and putting a second expander next to the
 * one that already exists would be two doors to one room.
 */
export function AgentDots({
  tools,
  /** Older turn: do not paint units as live. Mirrors ToolActivity. */
  demoteLive = false
}: {
  tools: ToolCallInfo[]
  demoteLive?: boolean
}) {
  const view = useMemo(
    () => agentDots(extractAgentUnits(tools), { demoteLive }),
    [tools, demoteLive]
  )

  if (view.dots.length === 0) return null
  // Nothing running and nothing broken means nothing to glance at, and a row of
  // identical squares reads as decoration rather than telemetry — a dozen finished
  // background commands painted a dozen identical marks. The strip exists to catch
  // an eye; when there is nothing to catch it, the tray holds the detail.
  if (view.live === 0 && view.failed === 0) return null

  return (
    <div
      className={`agent-dots ${view.live > 0 ? 'live' : ''}`}
      role="img"
      aria-label={view.label}
      title={view.label}
    >
      {view.dots.map((tone, i) => (
        <span key={i} className={`agent-dot ${tone}`} aria-hidden />
      ))}
    </div>
  )
}
