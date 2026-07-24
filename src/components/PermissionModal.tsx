import type { PermissionRequest } from '../../shared/types'

interface Props {
  request: PermissionRequest
  onRespond: (decision: 'allow-once' | 'allow-always' | 'reject-once') => void
}

export function PermissionModal({ request, onRespond }: Props) {
  const kind = request.kind || 'tool'
  const isFsWrite = kind === 'fs/write' || /write/i.test(kind)
  const detail =
    request.rawInput === undefined
      ? ''
      : typeof request.rawInput === 'string'
        ? request.rawInput
        : JSON.stringify(request.rawInput, null, 2)

  // Prefer structured kind over free-text agent title (approval-spoofing surface)
  const headline = isFsWrite
    ? 'Write a file on disk'
    : kind && kind !== 'tool'
      ? `Run ${kind}`
      : 'Authorize tool'

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-kicker" data-kicker="PERMISSION">
        <h3>{headline}</h3>
        <p>
          Agent requests <strong>{kind}</strong>
          {request.title ? (
            <>
              {' '}
              · labeled <em>{request.title}</em>
            </>
          ) : null}
          . Review carefully — the title text is agent-controlled.
        </p>
        {detail ? <pre>{detail}</pre> : null}
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
            onClick={() => onRespond('allow-always')}
          >
            Always allow
          </button>
        </div>
      </div>
    </div>
  )
}
