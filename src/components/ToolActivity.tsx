import { useMemo, useState } from 'react'
import type { ToolCallInfo } from '../../shared/types'
import { ToolCard, toolBrief } from './ToolCard'
import { formatTool } from '../lib/tool-format'
import { extractImageRefsFromTools } from '../lib/image-refs'
import {
  agentActivitySummary,
  extractAgentUnits,
  isAgentActivityTool
} from '../lib/agent-activity'
import { ImageGallery } from './LocalImage'
import { AgentFleet } from './AgentFleet'

/**
 * Compact tool activity for a message turn.
 *
 * One bar by default (click to expand). Live agent units and tool cards live
 * inside the expand so Agent fleet and "Using SHELL" do not both pulse as if
 * they were different systems. Path/command briefs are display-shortened.
 */
export function ToolActivity({
  tools,
  /** Older turns whose tools still say in_progress after a newer message exists */
  demoteLive = false
}: {
  tools: ToolCallInfo[]
  demoteLive?: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  const { active, failed, images, agents, agentSummary } = useMemo(() => {
    const agents = extractAgentUnits(tools)
    const agentSummary = agentActivitySummary(agents)
    const active = demoteLive
      ? undefined
      : [...tools].reverse().find((t) => t.status === 'in_progress' || t.status === 'pending')
    const failed = tools.filter((t) => t.status === 'failed')
    const images = extractImageRefsFromTools(
      tools.filter((t) => t.status === 'completed')
    )
    return { active, failed, images, agents, agentSummary }
  }, [tools, demoteLive])

  const live = !!active && !demoteLive
  const agentLive = !demoteLive && agentSummary.live > 0

  const summaryLine = useMemo(() => {
    if (active) {
      // Prefer agent unit label when the live tool is agent telemetry
      if (isAgentActivityTool(active)) {
        const unit = agents.find((a) => a.id === active.toolCallId)
        if (unit) {
          const tail = unit.detail ? ` · ${unit.detail}` : ''
          const line = `${unit.label}${tail}`
          return line.length > 72 ? line.slice(0, 69) + '…' : line
        }
      }
      return toolBrief(active)
    }
    if (failed.length) {
      return `${failed.length} failed · ${toolBrief(failed[failed.length - 1])}`
    }
    if (images.length) {
      return images.length === 1
        ? `IMAGE  ${images[0].label}`
        : `IMAGE  ${images.length} images`
    }
    if (tools.length === 1) return toolBrief(tools[0])
    const agentHint =
      agents.length > 0
        ? agentLive
          ? ` · ${agentSummary.live} agent${agentSummary.live === 1 ? '' : 's'} live`
          : ` · ${agents.length} agent${agents.length === 1 ? '' : 's'}`
        : ''
    return `${tools.length} tools${agentHint}`
  }, [active, failed, images, tools, agents, agentLive, agentSummary.live])

  const showCollapsedGallery = !expanded && images.length > 0

  const label = live
    ? agentLive && active && isAgentActivityTool(active)
      ? 'Agents'
      : 'Using'
    : failed.length
      ? 'Tools'
      : images.length
        ? 'Image'
        : 'Used'

  return (
    <div
      className={`tool-activity ${live ? 'live' : ''} ${expanded ? 'expanded' : ''} ${
        // Worth the card even when collapsed: a failure needs to be seen, and
        // images are content rather than bookkeeping.
        failed.length || images.length ? 'notable' : ''
      }`}
    >
      <button
        type="button"
        className="tool-activity-bar"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title={expanded ? 'Hide tool details' : summaryLine}
      >
        <span className="tool-activity-icon" aria-hidden>
          {live ? '◎' : failed.length ? '!' : images.length ? '▣' : '✓'}
        </span>
        <span className="tool-activity-label">{label}</span>
        <span className="tool-activity-brief" title={summaryLine}>
          {summaryLine}
        </span>
        <span className="tool-activity-count">
          {tools.length > 1 ? `${tools.length}` : ''}
        </span>
        {agentLive ? (
          <span className="tool-activity-agents-hint" title="Spawned agent work still running">
            {agentSummary.live} live
          </span>
        ) : null}
        <span className="tool-activity-chevron" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {showCollapsedGallery ? (
        <div className="tool-activity-images">
          <ImageGallery images={images} />
        </div>
      ) : null}

      {/*
       * The chip row that used to sit here is gone. It listed up to six tools as
       * bordered labels, wrapping to as many as five rows on a busy turn, and it
       * spent a border and a word on each one whether or not anything had gone
       * wrong. The glance is now AgentDots, rendered by MessageList under the
       * message itself; this bar and the expand below it are the detail.
       */}
      {expanded ? (
        <div className="tool-activity-body">
          {agents.length > 0 ? <AgentFleet tools={tools} embedded demoteLive={demoteLive} /> : null}
          <div className="tool-list">
            {tools.map((t) => {
              const showLive =
                !demoteLive && (t.status === 'in_progress' || t.status === 'pending')
              return (
                <ToolCard
                  key={t.toolCallId}
                  tool={
                    demoteLive && (t.status === 'in_progress' || t.status === 'pending')
                      ? { ...t, status: 'completed' }
                      : t
                  }
                  defaultOpen={
                    t.status === 'failed' ||
                    showLive ||
                    !!formatTool(t).images?.length
                  }
                />
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}
