import { useState } from 'react'
import type { PermissionRequest } from '../../shared/types'
import { diffMark, formatPermission } from '../lib/tool-format'
import type { DiffLine, FormattedPermission } from '../lib/tool-format'

interface Props {
  request: PermissionRequest
  onRespond: (decision: 'allow-once' | 'allow-always' | 'allow-session' | 'reject-once') => void
}

/**
 * formatPermission already fails soft, but this modal is the only way to answer
 * a request that is blocking the agent: an unrenderable modal would strand the
 * user with neither Deny nor Allow. Two layers is cheap insurance.
 */
function safeFormat(request: PermissionRequest): FormattedPermission | null {
  try {
    return formatPermission(request)
  } catch {
    return null
  }
}

export function PermissionModal({ request, onRespond }: Props) {
  // Keyed by request id, not a bare flag: the component stays mounted across
  // back-to-back requests, and each one gets its own default disclosure state.
  const [rawOverride, setRawOverride] = useState<{
    id: number | string
    open: boolean
  } | null>(null)
  const kind = request.kind || 'tool'
  const isFsWrite = kind === 'fs/write' || /write/i.test(kind)
  const fmt = safeFormat(request)
  const diff = fmt?.diffLines || []
  // Nothing was recognised in the payload: the raw view is all the user has.
  const rawIsAllThereIs = !!fmt && !fmt.subject && diff.length === 0 && fmt.facts.length === 0
  const showRaw =
    rawOverride && rawOverride.id === request.requestId ? rawOverride.open : rawIsAllThereIs

  // Prefer structured kind over free-text agent title (approval-spoofing surface)
  const headline = isFsWrite
    ? 'Write a file on disk'
    : kind && kind !== 'tool'
      ? `Run ${kind}`
      : 'Authorize tool'

  // Titles can be multi-kilobyte shell lines; keep the intro readable.
  const titlePreview =
    request.title && request.title.length > 160
      ? `${request.title.slice(0, 157)}…`
      : request.title

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-kicker modal-permission" data-kicker="PERMISSION">
        <h3>{headline}</h3>
        <p>
          Agent requests <strong>{kind}</strong>
          {titlePreview ? (
            <>
              {' '}
              · labeled <em title={request.title || undefined}>{titlePreview}</em>
            </>
          ) : null}
          . Review carefully. The title text is agent-controlled.
        </p>

        {/*
          Payload scrolls inside the modal; the action row is flex-fixed below so
          Deny/Allow stay reachable even for execute payloads that fill the screen.
        */}
        <div className="permission-detail">
          {fmt ? null : (
            <pre>
              This request could not be displayed. Deny it unless you know exactly what it is.
            </pre>
          )}

          {fmt && fmt.subject ? (
            <>
              {/* Reusing the tool-card caption class: this agent does not own styles.css */}
              <div className="tool-diff-path">{fmt.subjectLabel}</div>
              <pre>{fmt.subject}</pre>
            </>
          ) : null}

          {diff.length > 0 ? (
            <>
              <div className="tool-diff-path">
                {fmt?.path || 'file'} · +{fmt?.added ?? 0} −{fmt?.removed ?? 0}
                {fmt?.diffTruncated ? ' · clipped for display' : ''}
              </div>
              <pre className="diff-pre">
                {diff.map((line, i) => (
                  <div key={i} className={`diff-line ${line.type}`}>
                    <span className="diff-mark">{diffMark(line.type)}</span>
                    {line.text}
                  </div>
                ))}
              </pre>
            </>
          ) : null}

          {fmt && fmt.facts.length > 0 ? (
            <pre>{fmt.facts.map((f) => `${f.label}: ${f.value}`).join('\n')}</pre>
          ) : null}

          {fmt && fmt.raw ? (
            <>
              {/* A diff hides context by design — keep the exact payload one click away */}
              <p className="btn-row">
                <button
                  type="button"
                  className="btn-mini"
                  aria-expanded={showRaw}
                  onClick={() => setRawOverride({ id: request.requestId, open: !showRaw })}
                >
                  {showRaw ? 'Hide raw payload' : 'Show raw payload'}
                </button>
              </p>
              {showRaw ? (
                <>
                  {fmt.rawTruncated ? (
                    <div className="tool-diff-path">payload clipped for display</div>
                  ) : null}
                  <pre>{fmt.raw}</pre>
                </>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="modal-actions">
          {/* FIX-15: Deny is primary / leftmost safe default */}
          <button
            type="button"
            className="btn btn-primary"
            autoFocus
            onClick={() => onRespond('reject-once')}
          >
            Deny
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onRespond('allow-once')}
          >
            Allow once
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onRespond('allow-session')}
            title="Auto-approve this tool kind until this agent session ends"
          >
            Allow this kind for session
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onRespond('allow-always')}
            title="Persist an always-allow decision in the CLI where supported"
          >
            Always allow
          </button>
        </div>
      </div>
    </div>
  )
}
