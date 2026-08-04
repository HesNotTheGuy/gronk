import type { ToolCallStatus } from '../../shared/types'
import type { AgentUnit } from './agent-activity'

/**
 * What the glance layer shows for one message: a row of dots, one per agent unit
 * that message spawned.
 *
 * Split from the component for the same reason as scroll-stick.ts and
 * context-menu-items.ts: the suite is `node --test` with no DOM, so a decision
 * living inside a component cannot be reached. Everything here is a mapping over
 * plain data.
 *
 * The vocabulary is three tones and no words, per the stylesheet's own header:
 * "Aerospace HUD, pure black, white telemetry, one hard accent" and "Hierarchy
 * is luminance". A failure has to be visible without reading anything, which is
 * what the chips it replaces could not do: every chip carried a border, a label
 * and equal weight, so a failed one looked like the other five.
 */

/** dim, accent, pulsing. There is no fourth. */
export type DotTone = 'done' | 'failed' | 'live'

export interface AgentDotsView {
  /** One per unit, in the order the message spawned them. */
  dots: DotTone[]
  failed: number
  live: number
  /**
   * Text for assistive tech only. The dots deliberately carry no visible label,
   * which would put a screen reader in front of an unlabelled row of divs; this
   * is the same information said once, invisibly.
   */
  label: string
}

/**
 * One unit's status as a tone.
 *
 * `cancelled` is painted as a failure on purpose. It is not the same event, but
 * the vocabulary has one accent by design and a cancelled agent did not finish
 * its work. Showing it dim would file it with the successes, which is the more
 * misleading of the two available lies. `agentActivitySummary` already buckets
 * it this way, so the dots and the tray count the same thing.
 *
 * `demoteLive` is the same idea as ToolActivity's: a turn that is no longer the
 * newest should not pulse forever because a tool call was never marked done.
 */
export function statusToDot(status: ToolCallStatus, demoteLive = false): DotTone {
  switch (status) {
    case 'in_progress':
    case 'pending':
      return demoteLive ? 'done' : 'live'
    case 'failed':
    case 'cancelled':
      return 'failed'
    case 'completed':
      return 'done'
    default:
      // An unknown status is not evidence of failure. Fail quiet, not loud:
      // painting it with the one accent would cry wolf on the single signal
      // this row exists to carry.
      return 'done'
  }
}

function describe(total: number, failed: number, live: number): string {
  if (total === 0) return ''
  const noun = total === 1 ? 'agent' : 'agents'
  const parts: string[] = []
  if (live) parts.push(`${live} running`)
  if (failed) parts.push(`${failed} failed`)
  if (parts.length === 0) return `${total} ${noun}, all finished`
  return `${total} ${noun}: ${parts.join(', ')}`
}

/**
 * The whole glance row for one message.
 *
 * Order is spawn order, not severity order. The tray sorts live and failed to
 * the front because it is a list you read; this is a strip you look at, where
 * position means when and colour means what. Sorting would destroy the first
 * without improving the second, since a red dot is equally visible wherever it
 * sits.
 *
 * There is no cap and no overflow marker. A count of agents is small in
 * practice, and "+3" is exactly the kind of thing that has to be read.
 */
export function agentDots(
  units: AgentUnit[],
  opts?: { demoteLive?: boolean }
): AgentDotsView {
  const demoteLive = opts?.demoteLive ?? false
  const dots = units.map((u) => statusToDot(u.status, demoteLive))
  let failed = 0
  let live = 0
  for (const d of dots) {
    if (d === 'failed') failed++
    else if (d === 'live') live++
  }
  return { dots, failed, live, label: describe(dots.length, failed, live) }
}
