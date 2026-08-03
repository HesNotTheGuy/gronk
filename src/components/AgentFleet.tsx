import { useEffect, useMemo, useRef, useState } from 'react'
import type { ToolCallInfo } from '../../shared/types'
import {
  agentActivitySummary,
  collectAgentUnitsFromMessages,
  extractAgentUnits,
  orderUnitsForDisplay,
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
  tools
}: {
  tools: ToolCallInfo[]
}) {
  const units = useMemo(() => extractAgentUnits(tools), [tools])
  const summary = useMemo(() => agentActivitySummary(units), [units])
  const [open, setOpen] = useState(summary.live > 0)
  const prevLive = useRef(summary.live)

  useEffect(() => {
    if (summary.live > 0 && prevLive.current === 0) setOpen(true)
    if (summary.live === 0 && prevLive.current > 0) setOpen(false)
    prevLive.current = summary.live
  }, [summary.live])

  if (!units.length) return null

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
          {orderUnitsForDisplay(units).map((u) => (
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
      {open ? (
        <p className="agent-fleet-note">
          From Grok tool calls only (e.g. spawn_subagent). No extra model narration.
        </p>
      ) : null}
    </div>
  )
}

/**
 * Session-level strip above the composer. Collapses by default when nothing is
 * live, auto-expands when work starts, auto-collapses when it ends, and can be
 * dismissed until the next live spawn so finished agents stop owning the pane.
 */
export function AgentFleetStrip({
  messages
}: {
  messages: Array<{ toolCalls?: ToolCallInfo[] }>
}) {
  const units = useMemo(
    () => collectAgentUnitsFromMessages(messages, { maxMessages: 16 }),
    [messages]
  )
  const summary = useMemo(() => agentActivitySummary(units), [units])
  const [expanded, setExpanded] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const prevLive = useRef(0)

  useEffect(() => {
    if (summary.live > 0) {
      // New live work always comes back into view.
      setDismissed(false)
      if (prevLive.current === 0) setExpanded(true)
    } else if (prevLive.current > 0) {
      // Everything finished: reclaim the chat box.
      setExpanded(false)
    }
    prevLive.current = summary.live
  }, [summary.live])

  if (!units.length || dismissed) return null

  const ordered = orderUnitsForDisplay(units)
  const chipCap = 8
  const chips = ordered.slice(0, chipCap)
  const overflow = ordered.length - chips.length

  return (
    <div className="agent-fleet-strip-wrap">
      <div className={`agent-fleet strip ${summary.live ? 'live' : ''} ${expanded ? 'open' : ''}`}>
        <div className="agent-fleet-strip-bar">
          <button
            type="button"
            className="agent-fleet-head strip-head"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            title="Spawned agents & background tasks from Grok tools"
          >
            <span className="agent-fleet-icon" aria-hidden>
              {summary.live ? '◎' : summary.failed ? '!' : '▣'}
            </span>
            <span className="agent-fleet-title">Agents</span>
            <span className="agent-fleet-stats">
              {summary.live ? (
                <span className="agent-stat live">{summary.live} live</span>
              ) : null}
              {summary.done ? <span className="agent-stat">{summary.done} done</span> : null}
              {summary.failed ? (
                <span className="agent-stat fail">{summary.failed} fail</span>
              ) : null}
              {!summary.live && !summary.done && !summary.failed ? (
                <span className="agent-stat">{summary.total}</span>
              ) : null}
            </span>
            <span className="agent-fleet-chevron" aria-hidden>
              {expanded ? '▾' : '▸'}
            </span>
          </button>
          <button
            type="button"
            className="agent-fleet-dismiss"
            title={
              summary.live
                ? 'Hide for now (returns if new agents start)'
                : 'Hide finished agents until new ones start'
            }
            aria-label="Hide agent strip"
            onClick={() => {
              setDismissed(true)
              setExpanded(false)
            }}
          >
            ×
          </button>
        </div>
        {expanded ? (
          <div className="agent-chip-row">
            {chips.map((u) => (
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
            {overflow > 0 ? <span className="agent-chip more">+{overflow}</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
