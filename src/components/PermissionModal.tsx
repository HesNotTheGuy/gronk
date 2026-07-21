import type { PermissionRequest } from '../../shared/types'

interface Props {
  request: PermissionRequest
  onRespond: (decision: 'allow-once' | 'allow-always' | 'reject-once') => void
}

export function PermissionModal({ request, onRespond }: Props) {
  const detail =
    request.rawInput === undefined
      ? ''
      : typeof request.rawInput === 'string'
        ? request.rawInput
        : JSON.stringify(request.rawInput, null, 2)

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h3>Authorization required</h3>
        <p>
          Agent requests execution of <strong>{request.title}</strong>
          {request.kind ? ` · ${request.kind}` : ''}. Confirm or abort this tool call.
        </p>
        {detail ? <pre>{detail}</pre> : null}
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => onRespond('reject-once')}
          >
            Deny
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onRespond('allow-always')}
          >
            Always allow
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onRespond('allow-once')}
          >
            Authorize
          </button>
        </div>
      </div>
    </div>
  )
}
