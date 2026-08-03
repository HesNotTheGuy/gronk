import { useEffect, useState } from 'react'
import type { ToolCallInfo } from '../../shared/types'
import { diffMark, formatTool, shortenForDisplay } from '../lib/tool-format'
import { ImageGallery } from './LocalImage'

function statusLabel(status: ToolCallInfo['status']): string {
  switch (status) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'fail'
    case 'in_progress':
      return 'running'
    case 'pending':
      return 'auth'
    case 'cancelled':
      return 'abort'
    default:
      return String(status).replace('_', ' ')
  }
}

function kindGlyph(kind: string): string {
  switch (kind) {
    case 'EDIT':
      return '✎'
    case 'READ':
      return '◈'
    case 'SHELL':
      return '›'
    case 'SEARCH':
      return '⌕'
    case 'NET':
      return '⇄'
    case 'LIST':
      return '☰'
    case 'IMAGE':
      return '▣'
    default:
      return '·'
  }
}

/** One-line human brief: "READ package.json" / "SHELL npm test" */
export function toolBrief(tool: ToolCallInfo): string {
  const fmt = formatTool(tool)
  const summary = fmt.summary.replace(/\s+/g, ' ').trim()
  const short =
    summary.length > 72 ? summary.slice(0, 69).replace(/\s+\S*$/, '') + '…' : summary
  return `${fmt.kindLabel}  ${short}`
}

export function ToolCard({
  tool,
  defaultOpen
}: {
  tool: ToolCallInfo
  defaultOpen?: boolean
}) {
  const live = tool.status === 'in_progress' || tool.status === 'pending'
  const [open, setOpen] = useState(
    defaultOpen ?? (tool.status === 'failed')
  )
  const fmt = formatTool(tool)

  // Keep open if it fails mid-run; collapse when it succeeds unless user opened it
  useEffect(() => {
    if (tool.status === 'failed') setOpen(true)
  }, [tool.status])

  const brief = toolBrief(tool)
  const images = fmt.images || []
  // Always surface generated images — that's the useful output, not the path dump
  const showImages = images.length > 0 && tool.status === 'completed'

  return (
    <div
      className={`tool-card kind-${fmt.kindLabel.toLowerCase()} status-${tool.status} ${open ? 'open' : ''} ${live ? 'live' : ''}`}
    >
      <button
        type="button"
        className="tool-head"
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Hide details' : 'Show tool details'}
        aria-expanded={open}
      >
        <span className="tool-icon" aria-hidden>
          {kindGlyph(fmt.kindLabel)}
        </span>
        <span className="tool-brief">
          <span className="tool-kind">{fmt.kindLabel}</span>
          <span className="tool-title" title={fmt.path || fmt.summary}>
            {fmt.summary}
          </span>
        </span>
        <span className={`tool-status ${tool.status}`}>
          {live ? <span className="tool-pulse" aria-hidden /> : null}
          {statusLabel(tool.status)}
        </span>
        <span className="tool-chevron" aria-hidden>
          {open ? '▾' : '▸'}
        </span>
      </button>
      {showImages ? (
        <div className="tool-images">
          <ImageGallery images={images} />
        </div>
      ) : null}
      {open ? (
        <div className="tool-body">
          <div className="tool-brief-line">{brief}</div>
          {fmt.diffLines && fmt.diffLines.length > 0 ? (
            <div className="tool-diff">
              {fmt.path ? (
                <div className="tool-diff-path" title={fmt.path}>
                  {shortenForDisplay(fmt.path, 120)}
                </div>
              ) : null}
              <pre className="diff-pre">
                {fmt.diffLines.map((line, i) => (
                  <div key={i} className={`diff-line ${line.type}`}>
                    <span className="diff-mark">{diffMark(line.type)}</span>
                    {line.text}
                  </div>
                ))}
              </pre>
            </div>
          ) : null}
          {fmt.body ? <div className="tool-payload">{fmt.body}</div> : null}
          {!fmt.body && !fmt.diffLines?.length && !showImages ? (
            <div className="tool-payload muted">No extra payload</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
