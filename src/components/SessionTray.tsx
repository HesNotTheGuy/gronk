import { useEffect, useMemo, useRef, useState } from 'react'
import type { ActivePlan, AuthStatus, ChatMessage, SessionUsage } from '../../shared/types'
import {
  agentActivitySummary,
  collectAgentUnitsFromMessages,
  orderUnitsForDisplay
} from '../lib/agent-activity'
import { statusToDot } from '../lib/agent-dots'
import { costNote, detailCostLabel, summaryCostLabel } from '../lib/cost'
import { shortenForDisplay } from '../lib/tool-format'

type TrayTab = 'plan' | 'agents' | 'usage'

function planStatusClass(status: string): string {
  const s = status.toLowerCase()
  if (s.includes('complete') || s === 'done') return 'done'
  if (s.includes('progress') || s === 'running' || s === 'active') return 'run'
  if (s.includes('fail') || s.includes('error')) return 'fail'
  return 'pending'
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k < 100 ? k.toFixed(1) : Math.round(k)}K`
  }
  const m = n / 1_000_000
  return `${m < 10 ? m.toFixed(2) : m.toFixed(1)}M`
}

function formatExact(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : '0'
}

function formatCost(usd?: number): string | null {
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return null
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function cachedShare(inputTokens: number, cached: number): number | null {
  if (inputTokens <= 0 || cached <= 0) return null
  return Math.min(100, Math.round((cached / inputTokens) * 100))
}

interface Props {
  /** Build surface only */
  showPlan: boolean
  plan: ActivePlan | null
  messages: ChatMessage[]
  usage: SessionUsage | null
  auth?: AuthStatus | null
}

/**
 * One strip above the composer for Plan, Agents, and Usage.
 *
 * Stacking three full-width panels left no room for the chat. This tray is a
 * single thin rail of tabs; only one body expands at a time, and empty sections
 * do not appear.
 */
export function SessionTray({ showPlan, plan, messages, usage, auth }: Props) {
  // Wide scan so status updates still reach units that started many turns ago.
  // Display history is the sticky `retained` list below — a 16-message window
  // made the AGENTS tab vanish as soon as chat moved on, which felt like
  // "only while something is running".
  const fromMessages = useMemo(
    () => collectAgentUnitsFromMessages(messages, { maxMessages: 200 }),
    [messages]
  )
  const [retained, setRetained] = useState<typeof fromMessages>([])
  const [tab, setTab] = useState<TrayTab | null>(null)
  const [agentsDismissed, setAgentsDismissed] = useState(false)
  const prevLive = useRef(0)

  // Merge newly seen units into session memory; never drop on an empty scan.
  useEffect(() => {
    if (fromMessages.length === 0) return
    setRetained((prev) => {
      const byId = new Map(prev.map((u) => [u.id, u]))
      for (const u of fromMessages) byId.set(u.id, u)
      return [...byId.values()]
    })
  }, [fromMessages])

  const units = retained
  const agentSummary = useMemo(() => agentActivitySummary(units), [units])

  const hasPlan = showPlan && !!plan && plan.entries.length > 0
  // Tab stays for the whole session once any agent has been seen, until ×.
  const hasAgents = !agentsDismissed && units.length > 0
  const hasUsage = !!usage && usage.turns > 0

  useEffect(() => {
    // Deliberately does NOT open the panel when work starts.
    //
    // It used to: a 0 to 1 transition in live agents called setTab('agents'),
    // so a panel appeared under the reader mid-sentence and pushed the
    // transcript. That is the same defect as the streaming scroll fixed in
    // 8042d18, arriving from the other direction, and it is worse here because
    // the user did not ask for the panel at all. The tab already reads
    // "AGENTS n live", and the dots under the spawning message now show the
    // same thing in place, so nothing is lost by waiting to be asked.
    //
    // Failures do not open it either. A failed dot takes the one hard accent
    // and is visible where the work was started, which is the point of having
    // a glance layer: it means the detail never has to interrupt.
    if (agentSummary.live > 0) {
      setAgentsDismissed(false)
    } else if (prevLive.current > 0 && tab === 'agents') {
      // Collapse the expanded body when the last agent finishes, but leave the
      // tab itself so the user can reopen history without waiting for new work.
      setTab(null)
    }
    prevLive.current = agentSummary.live
  }, [agentSummary.live, tab])

  // Drop a selected tab if its content disappears (plan finished clearing, etc.)
  useEffect(() => {
    if (tab === 'plan' && !hasPlan) setTab(null)
    if (tab === 'agents' && !hasAgents) setTab(null)
    if (tab === 'usage' && !hasUsage) setTab(null)
  }, [tab, hasPlan, hasAgents, hasUsage])

  if (!hasPlan && !hasAgents && !hasUsage) return null

  const planDone = hasPlan
    ? plan!.entries.filter((e) => planStatusClass(e.status) === 'done').length
    : 0
  const planTotal = hasPlan ? plan!.entries.length : 0

  const sessionCost = hasUsage ? formatCost(usage!.totals.costUsd) : null
  const costSuffix = hasUsage ? summaryCostLabel(auth) : null
  const share = hasUsage
    ? cachedShare(usage!.totals.inputTokens, usage!.totals.cachedReadTokens)
    : null

  const select = (next: TrayTab) => {
    setTab((cur) => (cur === next ? null : next))
  }

  const orderedAgents = orderUnitsForDisplay(units)
  const agentChips = orderedAgents.slice(0, 8)
  const agentOverflow = orderedAgents.length - agentChips.length

  return (
    <div className={`session-tray ${tab ? 'open' : ''} ${agentSummary.live ? 'live' : ''}`}>
      <div className="session-tray-rail" role="tablist" aria-label="Session details">
        {hasPlan ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'plan'}
            className={`session-tray-tab ${tab === 'plan' ? 'active' : ''}`}
            onClick={() => select('plan')}
            title="Agent plan for this session"
          >
            <span className="session-tray-kicker">Plan</span>
            <span className="session-tray-value">
              {planDone}/{planTotal}
            </span>
          </button>
        ) : null}

        {hasAgents ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'agents'}
            className={`session-tray-tab ${tab === 'agents' ? 'active' : ''} ${agentSummary.live ? 'live' : ''}`}
            onClick={() => select('agents')}
            title="Spawned agents and background tasks"
          >
            <span className="session-tray-kicker">Agents</span>
            <span className="session-tray-value">
              {agentSummary.live > 0 ? (
                <span className="session-tray-live">{agentSummary.live} live</span>
              ) : (
                `${agentSummary.total}`
              )}
            </span>
          </button>
        ) : null}

        {hasUsage ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'usage'}
            className={`session-tray-tab ${tab === 'usage' ? 'active' : ''}`}
            onClick={() => select('usage')}
            title="Token use reported by the Grok CLI for this session"
          >
            <span className="session-tray-kicker">Usage</span>
            <span className="session-tray-value">
              {formatTokens(usage!.totals.totalTokens)}
              {sessionCost && costSuffix ? ` · ~${sessionCost}` : ''}
            </span>
          </button>
        ) : null}

        <span className="session-tray-spacer" />

        {tab === 'agents' ? (
          <button
            type="button"
            className="session-tray-dismiss"
            title="Hide agents until new work starts"
            aria-label="Hide agents"
            onClick={() => {
              setAgentsDismissed(true)
              setRetained([])
              setTab(null)
            }}
          >
            ×
          </button>
        ) : null}

        {tab ? (
          <button
            type="button"
            className="session-tray-collapse"
            title="Collapse"
            aria-label="Collapse session tray"
            onClick={() => setTab(null)}
          >
            ▾
          </button>
        ) : (
          <span className="session-tray-hint" aria-hidden>
            ▸
          </span>
        )}
      </div>

      {tab === 'plan' && hasPlan ? (
        <div className="session-tray-body" role="tabpanel">
          <ul className="plan-list">
            {plan!.entries.map((e) => (
              <li key={e.id} className={`plan-item ${planStatusClass(e.status)}`}>
                <span className="plan-dot" aria-hidden />
                <span className="plan-text">{e.content}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {tab === 'agents' && hasAgents ? (
        <div className="session-tray-body" role="tabpanel">
          {/*
            Detail list, not a second glance strip: status is the same dot tones
            as AgentDots (luminance hierarchy, one accent for fail). Labels stay
            so you can tell agents apart; kind tags and RUN/DONE words go.
            Paths in labels/titles run through shortenForDisplay so a home
            directory never lands in the tray (or a screenshot of it).
          */}
          <div className="agent-tray-list">
            {agentChips.map((u) => {
              const tone = statusToDot(u.status)
              // Tight cap: identity over provenance; long tool titles become noise.
              const label = shortenForDisplay(u.label, 48)
              const detail = u.detail ? shortenForDisplay(u.detail, 72) : ''
              return (
                <div
                  key={u.id}
                  className="agent-tray-row"
                  title={[label, detail, u.source ? shortenForDisplay(u.source, 72) : '']
                    .filter(Boolean)
                    .join('\n')}
                >
                  <span className={`agent-dot ${tone}`} aria-hidden />
                  <span className="agent-tray-label">{label}</span>
                </div>
              )
            })}
            {agentOverflow > 0 ? (
              <div className="agent-tray-more">+{agentOverflow} more</div>
            ) : null}
          </div>
          <p className="session-tray-note">From Grok tool calls only. No extra model narration.</p>
        </div>
      ) : null}

      {tab === 'usage' && hasUsage ? (
        <div className="session-tray-body usage-detail" role="tabpanel">
          <div className="usage-cols">
            <UsageCol label="Session total" usage={usage!.totals} auth={auth} />
            {usage!.last ? <UsageCol label="Last turn" usage={usage!.last} auth={auth} /> : null}
          </div>
          <p className="usage-note session-tray-note">
            Reported by the Grok CLI. {costNote(auth)} The CLI compacts context on its own, so
            there is nothing here to manage.
          </p>
          {share !== null ? (
            <p className="session-tray-note muted">
              Cache hit rate {share}% of prompt tokens this session
              {usage!.totals.cachedReadTokens
                ? ` (${formatExact(usage!.totals.cachedReadTokens)} tokens)`
                : ''}
              .
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function UsageCol({
  label,
  usage,
  auth
}: {
  label: string
  usage: SessionUsage['totals']
  auth?: AuthStatus | null
}) {
  const share = cachedShare(usage.inputTokens, usage.cachedReadTokens)
  const cost = formatCost(usage.costUsd)
  const note = costNote(auth)
  return (
    <div className="usage-col">
      <div className="usage-col-head">{label}</div>
      <dl className="usage-grid">
        <div className="usage-cell">
          <dt>In</dt>
          <dd title={formatExact(usage.inputTokens)}>{formatTokens(usage.inputTokens)}</dd>
        </div>
        <div className="usage-cell">
          <dt>Out</dt>
          <dd title={formatExact(usage.outputTokens)}>{formatTokens(usage.outputTokens)}</dd>
        </div>
        <div className="usage-cell cached">
          <dt>Cached</dt>
          <dd title={`${formatExact(usage.cachedReadTokens)} prompt tokens served from cache`}>
            {formatTokens(usage.cachedReadTokens)}
            {share !== null ? <span className="usage-share"> {share}%</span> : null}
          </dd>
        </div>
        <div className="usage-cell">
          <dt>Thinking</dt>
          <dd title={formatExact(usage.reasoningTokens)}>
            {formatTokens(usage.reasoningTokens)}
          </dd>
        </div>
        <div className="usage-cell">
          <dt>Calls</dt>
          <dd>{usage.modelCalls}</dd>
        </div>
        <div className="usage-cell">
          <dt>API time</dt>
          <dd>{formatDuration(usage.apiDurationMs)}</dd>
        </div>
        {cost ? (
          <div className="usage-cell">
            <dt>{detailCostLabel(auth)}</dt>
            <dd title={note}>~{cost}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  )
}
