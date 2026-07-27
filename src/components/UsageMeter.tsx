import { useState } from 'react'
import { costNote, detailCostLabel, summaryCostLabel } from '../lib/cost'
import type { AuthStatus, SessionUsage, TurnUsage } from '../../shared/types'

/**
 * Readable magnitudes. 45428 reads as "45.4K": the exact figure is available in
 * the row's title, and a raw six-digit number at a glance says nothing useful.
 */
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

/**
 * Null when there is no cost to show. The CLI reports 0 ticks for turns it did
 * not price, and "$0.00" would assert the turn was free — a stronger claim than
 * the data supports.
 */
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

/** Cached reads are a slice of the input tokens, so the share is of input. */
function cachedShare(usage: TurnUsage): number | null {
  if (usage.inputTokens <= 0 || usage.cachedReadTokens <= 0) return null
  return Math.min(100, Math.round((usage.cachedReadTokens / usage.inputTokens) * 100))
}

function UsageColumn({
  label,
  usage,
  auth
}: {
  label: string
  usage: TurnUsage
  auth: AuthStatus | null | undefined
}) {
  const share = cachedShare(usage)
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
        {/* Cached reads are why a large input can still be cheap — hiding them
            would make the input figure look alarming for no reason. */}
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
        {/* Always shown here, unlike the summary bar: the panel is opened
            deliberately, and the label says which of the two things it is. */}
        {cost ? (
          <div className="usage-cell">
            <dt>{detailCostLabel(auth)}</dt>
            <dd title={note}>~{cost}</dd>
          </div>
        ) : null}
      </dl>
      {usage.perModel && Object.keys(usage.perModel).length > 1 ? (
        <ul className="usage-models">
          {Object.entries(usage.perModel).map(([model, entry]) => {
            const modelCost = formatCost(entry.costUsd)
            return (
              <li key={model}>
                <span className="usage-model-name">{model}</span>
                <span className="usage-model-figs">
                  {formatTokens(entry.totalTokens)}
                  {modelCost ? ` · ~${modelCost}` : ''}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * Token and cost readout for the live session.
 *
 * Deliberately state-only — no effects, no callbacks into props. The panel it
 * sits next to shipped an infinite render loop from an effect that depended on
 * an inline-arrow prop's identity; there is nothing here for that bug to attach
 * to. There is also no percentage-full gauge: the CLI exposes no context-window
 * limit anywhere, so a fullness bar would be invented.
 */
export function UsageMeter({
  usage,
  auth
}: {
  usage: SessionUsage | null
  auth?: AuthStatus | null
}) {
  const [open, setOpen] = useState(false)

  if (!usage || usage.turns === 0) return null

  const { totals, last } = usage
  const sessionCost = formatCost(totals.costUsd)
  const share = cachedShare(totals)
  // Null on a subscription: the CLI reports a cost for every turn regardless of
  // credential, but only an API key actually spends money per token.
  const costSuffix = summaryCostLabel(auth)
  const note = costNote(auth)

  return (
    <div className={`usage-meter ${open ? 'open' : ''}`}>
      <button
        type="button"
        className="usage-summary"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Token use reported by the Grok CLI for this session"
      >
        <span className="usage-kicker">Usage</span>
        <span className="usage-figs">
          <span className="usage-fig" title={`${formatExact(totals.totalTokens)} tokens total`}>
            <span className="usage-fig-label">Session</span>
            {formatTokens(totals.totalTokens)}
          </span>
          {totals.cachedReadTokens > 0 ? (
            <span
              className="usage-fig cached"
              title={`${formatExact(totals.cachedReadTokens)} prompt tokens served from cache`}
            >
              {formatTokens(totals.cachedReadTokens)} cached
              {share !== null ? ` (${share}%)` : ''}
            </span>
          ) : null}
          {sessionCost && costSuffix ? (
            <span className="usage-fig cost" title={note}>
              ~{sessionCost} {costSuffix}
            </span>
          ) : null}
          <span className="usage-fig muted">
            {usage.turns} turn{usage.turns === 1 ? '' : 's'}
          </span>
          {last ? (
            <span
              className="usage-fig muted"
              title={`${formatExact(last.totalTokens)} tokens in the last turn`}
            >
              <span className="usage-fig-label">Last</span>
              {formatTokens(last.totalTokens)}
            </span>
          ) : null}
        </span>
        <span className="usage-chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <div className="usage-detail">
          <div className="usage-cols">
            <UsageColumn label="Session total" usage={totals} auth={auth} />
            {last ? <UsageColumn label="Last turn" usage={last} auth={auth} /> : null}
          </div>
          <p className="usage-note">
            Reported by the Grok CLI. {note} The CLI compacts context on its own, so
            there is nothing here to manage.
          </p>
        </div>
      ) : null}
    </div>
  )
}
