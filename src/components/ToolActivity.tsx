import { useMemo, useState } from 'react'
import type { ToolCallInfo } from '../../shared/types'
import { ToolCard, toolBrief } from './ToolCard'
import { formatTool } from '../lib/tool-format'
import { extractImageRefsFromTools } from '../lib/image-refs'
import { extractAgentUnits } from '../lib/agent-activity'
import { ImageGallery } from './LocalImage'
import { AgentFleet } from './AgentFleet'

/**
 * Compact tool activity for a message turn.
 * - Shows a one-line live brief for the active tool
 * - Lists finished tools as small chips
 * - Always shows generated images (Imagine) without requiring expand
 * - Expand for full cards (input/output/diff)
 */
export function ToolActivity({ tools }: { tools: ToolCallInfo[] }) {
  const [expanded, setExpanded] = useState(false)

  const { active, failed, images, agents } = useMemo(() => {
    const active = [...tools]
      .reverse()
      .find((t) => t.status === 'in_progress' || t.status === 'pending')
    const failed = tools.filter((t) => t.status === 'failed')
    const images = extractImageRefsFromTools(
      tools.filter((t) => t.status === 'completed')
    )
    const agents = extractAgentUnits(tools)
    return { active, failed, images, agents }
  }, [tools])

  const live = !!active
  const summaryLine = active
    ? toolBrief(active)
    : failed.length
      ? `${failed.length} failed · ${toolBrief(failed[failed.length - 1])}`
      : images.length
        ? images.length === 1
          ? `IMAGE  ${images[0].label}`
          : `IMAGE  ${images.length} images`
        : tools.length === 1
          ? toolBrief(tools[0])
          : `${tools.length} tools`

  // When the only interesting output is images, expand is optional —
  // still show the gallery collapsed so the chat feels visual.
  const showCollapsedGallery = !expanded && images.length > 0

  return (
    <div className={`tool-activity ${live ? 'live' : ''} ${expanded ? 'expanded' : ''}`}>
      {agents.length > 0 ? <AgentFleet tools={tools} /> : null}
      <button
        type="button"
        className="tool-activity-bar"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title={expanded ? 'Hide tool details' : 'Show tool details'}
      >
        <span className="tool-activity-icon" aria-hidden>
          {live ? '◎' : failed.length ? '!' : images.length ? '▣' : '✓'}
        </span>
        <span className="tool-activity-label">
          {live ? 'Using' : failed.length ? 'Tools' : images.length ? 'Image' : 'Used'}
        </span>
        <span className="tool-activity-brief" title={summaryLine}>
          {summaryLine}
        </span>
        <span className="tool-activity-count">
          {tools.length > 1 ? `${tools.length}` : ''}
        </span>
        <span className="tool-activity-chevron" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {showCollapsedGallery ? (
        <div className="tool-activity-images">
          <ImageGallery images={images} />
        </div>
      ) : null}

      {!expanded && tools.length > 1 && !images.length ? (
        <div className="tool-chip-row" aria-hidden={expanded}>
          {tools.slice(-6).map((t) => {
            const fmt = formatTool(t)
            return (
              <span
                key={t.toolCallId}
                className={`tool-chip status-${t.status} kind-${fmt.kindLabel.toLowerCase()}`}
                title={toolBrief(t)}
              >
                {fmt.kindLabel}
              </span>
            )
          })}
          {tools.length > 6 ? (
            <span className="tool-chip more">+{tools.length - 6}</span>
          ) : null}
        </div>
      ) : null}

      {expanded ? (
        <div className="tool-list">
          {tools.map((t) => (
            <ToolCard
              key={t.toolCallId}
              tool={t}
              defaultOpen={
                t.status === 'failed' ||
                t.status === 'in_progress' ||
                !!formatTool(t).images?.length
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}
