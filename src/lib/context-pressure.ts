import type { SessionUsage } from '../../shared/types'

/**
 * How expensive this conversation has become, and whether to say so.
 *
 * Every turn resends the conversation, so the cost of a session grows with the
 * square of its length rather than in step with it. Measured on a real session:
 * 104 turns whose context reached ~720k tokens cost roughly 36M input tokens, and
 * the same work split across four sessions would have cost about a quarter of
 * that. Nothing was wrong — no loop, no runaway tool — which is exactly why it is
 * worth saying out loud. The bill was the only evidence.
 *
 * This is about COST, not danger. The CLI compacts on its own, so a full context
 * does not break a session, and nothing here may imply it will. That distinction
 * is why the panel still refuses to draw a fullness bar: a bar approaching full
 * reads as "about to fail".
 */

export type PressureLevel = 'fine' | 'costly' | 'expensive'

export interface ContextPressure {
  level: PressureLevel
  /** Share of the model's window the last turn used, 0–1. Undefined when unknowable. */
  share?: number
  /** One sentence, or null when there is nothing worth saying. */
  advice: string | null
}

const COSTLY_AT = 0.5
const EXPENSIVE_AT = 0.75

/**
 * The last turn's input is the closest thing to "how big is this conversation
 * now": it is what was actually sent. Totals cannot answer it — they only grow,
 * so a long cheap session and a short expensive one look alike.
 *
 * Returns `fine` with no advice whenever the answer is not knowable: no usage yet,
 * or an agent that never reported a context window. Guessing a limit is what the
 * usage panel already refuses to do.
 */
export function contextPressure(
  usage: SessionUsage | null | undefined,
  contextTokens: number | undefined
): ContextPressure {
  const used = usage?.last?.inputTokens
  if (!used || !contextTokens || contextTokens <= 0) return { level: 'fine', advice: null }

  const share = used / contextTokens
  if (share < COSTLY_AT) return { level: 'fine', share, advice: null }

  // Named as money rather than danger, and it names the cheaper option instead of
  // only the problem. `/compact` is the agent's own command — Gronk does not
  // summarise anything itself — and starting a session is free.
  const level: PressureLevel = share >= EXPENSIVE_AT ? 'expensive' : 'costly'
  const pct = Math.round(share * 100)
  return {
    level,
    share,
    advice:
      level === 'expensive'
        ? `This conversation now fills about ${pct}% of the model's context, and every further turn resends it. A new session for the next piece of work costs a fraction of this; /compact shortens this one in place.`
        : `This conversation fills about ${pct}% of the model's context, and each turn resends all of it. Worth finishing here and starting a new session for the next piece of work.`
  }
}
