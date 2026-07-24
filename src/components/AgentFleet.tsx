import { useMemo, useState } from 'react'
import type { ToolCallInfo } from '../../shared/types'
import {
  agentActivitySummary,
  collectAgentUnitsFromMessages,
  extractAgentUnits,
  type AgentUnit
} from '../lib/agent-activity'

function statusShort(s: AgentUnit['status']): string {
  switch (s) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'fail'
    case 'in_progress':
      return 'run'
    case 'pending':
      return 'wait'
    case 'cancelled':
      return 'stop'
    default:
      return String(s)
  }
}

function kindTag(k: AgentUnit['kind']): string {
  switch (k) {
    case 'subagent':
      return 'AGENT'
    case 'background':
      return 'BG'
    case 'workflow':
      return 'FLOW'
    case 'monitor':
      return 'WATCH'
    case 'scheduler':
      return 'CRON'
    default:
      return 'TASK'
  }
}

/**
 * Visualizer for Grok-spawned subagents / background tasks / workflows.
 * Data is strictly ACP tool_call telemetry — no model interpretation.
 */
export function AgentFleet({
  tools,
  compact
}: {
  tools: ToolCallInfo[]
  /** Single-line chip strip without expand */
  compact?: boolean
}) {
  const units = useMemo(() => extractAgentUnits(tools), [tools])
  const summary = useMemo(() => agentActivitySummary(units), [units])
  const [open, setOpen] = useState(summary.live > 0)

  if (!units.length) return null

  if (compact) {
    return (
      <div className="agent-fleet compact" title="From Grok tool calls (spawn_subagent, background, …)">
        <span className="agent-fleet-kicker">Agents</span>
        <span className="agent-fleet-stats">
          {summary.live ? (
            <span className="agent-stat live">{summary.live} live</span>
          ) : null}
          {summary.done ? <span className="agent-stat">{summary.done} done</span> : null}
          {summary.failed ? (
            <span className="agent-stat fail">{summary.failed} fail</span>
          ) : null}
        </span>
        <div className="agent-chip-row">
          {units.slice(0, 8).map((u) => (
            <span
              key={u.id}
              className={`agent-chip status-${u.status} kind-${u.kind}`}
              title={[u.label, u.detail, u.source].filter(Boolean).join('\n')}
            >
              <span className="agent-chip-kind">{kindTag(u.kind)}</span>
              <span className="agent-chip-label">{u.label}</span>
              <span className="agent-chip-status">{statusShort(u.status)}</span>
            </span>
          ))}
          {units.length > 8 ? (
            <span className="agent-chip more">+{units.length - 8}</span>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className={`agent-fleet ${summary.live ? 'live' : ''} ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="agent-fleet-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Spawned agents & background tasks reported by Grok tools (not LLM-summarized)"
      >
        <span className="agent-fleet-icon" aria-hidden>
          {summary.live ? '◎' : summary.failed ? '!' : '▣'}
        </span>
        <span className="agent-fleet-title">Agent activity</span>
        <span className="agent-fleet-stats">
          <span className="agent-stat">{summary.total} total</span>
          {summary.live ? <span className="agent-stat live">{summary.live} live</span> : null}
          {summary.done ? <span className="agent-stat">{summary.done} done</span> : null}
          {summary.failed ? (
            <span className="agent-stat fail">{summary.failed} fail</span>
          ) : null}
        </span>
        <span className="agent-fleet-chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <ul className="agent-fleet-list">
          {units.map((u) => (
            <li key={u.id} className={`agent-row status-${u.status} kind-${u.kind}`}>
              <span className="agent-row-kind">{kindTag(u.kind)}</span>
              <span className="agent-row-main">
                <span className="agent-row-label" title={u.source}>
                  {u.label}
                </span>
                {u.detail ? (
                  <span className="agent-row-detail" title={u.detail}>
                    {u.detail}
                  </span>
                ) : null}
              </span>
              <span className={`agent-row-status ${u.status}`}>
                {u.status === 'in_progress' || u.status === 'pending' ? (
                  <span className="tool-pulse" aria-hidden />
                ) : null}
                {statusShort(u.status)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="agent-fleet-note">
        From Grok tool calls only (e.g. spawn_subagent) — no extra model narration.
      </p>
    </div>
  )
}

/** Session-level strip: merge agent tools from recent assistant messages. */
export function AgentFleetStrip({
  messages
}: {
  messages: Array<{ toolCalls?: ToolCallInfo[] }>
}) {
  const tools = useMemo(() => {
    const all: ToolCallInfo[] = []
    for (const m of messages.slice(-16)) {
      if (m.toolCalls?.length) all.push(...m.toolCalls)
    }
    return all
  }, [messages])

  // Gate on shared collector so strip/header stay consistent
  const units = useMemo(
    () => collectAgentUnitsFromMessages(messages, { maxMessages: 16 }),
    [messages]
  )
  if (!units.length) return null

  return (
    <div className="agent-fleet-strip-wrap">
      <AgentFleet tools={tools} compact />
    </div>
  )
}
