import { useState } from 'react'
import type { ToolCallInfo } from '../../shared/types'

function formatBody(tool: ToolCallInfo): string {
  const parts: string[] = []
  if (tool.rawInput !== undefined) {
    parts.push(
      typeof tool.rawInput === 'string'
        ? tool.rawInput
        : JSON.stringify(tool.rawInput, null, 2)
    )
  }
  if (tool.content !== undefined) {
    parts.push(
      typeof tool.content === 'string'
        ? tool.content
        : JSON.stringify(tool.content, null, 2)
    )
  }
  if (tool.error) parts.push(`Error: ${tool.error}`)
  return parts.join('\n\n---\n\n') || 'No payload'
}

function statusLabel(status: ToolCallInfo['status']): string {
  switch (status) {
    case 'completed':
      return 'ok'
    case 'failed':
      return 'fail'
    case 'in_progress':
      return 'run'
    case 'pending':
      return 'auth'
    case 'cancelled':
      return 'abort'
    default:
      return String(status).replace('_', ' ')
  }
}

export function ToolCard({ tool }: { tool: ToolCallInfo }) {
  const [open, setOpen] = useState(tool.status === 'failed')

  return (
    <div className="tool-card">
      <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="tool-icon">{(tool.kind || 'T').slice(0, 1).toUpperCase()}</span>
        <span className="tool-title">{tool.title}</span>
        <span className={`tool-status ${tool.status}`}>{statusLabel(tool.status)}</span>
      </button>
      {open && <div className="tool-body">{formatBody(tool)}</div>}
    </div>
  )
}
