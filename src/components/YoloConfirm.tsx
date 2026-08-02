interface Props {
  onConfirm: () => void
  onCancel: () => void
}

export function YoloConfirm({ onConfirm, onCancel }: Props) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-danger modal-kicker">
        <h3>Enable bypass permissions?</h3>
        <p>
          This sets permission mode to <strong>Bypass all (YOLO)</strong> for the Grok agent
          (<code>--permission-mode bypassPermissions</code> / <code>--always-approve</code>). The
          agent can edit files and run shell
          commands <strong>without asking</strong>.
        </p>
        <ul className="danger-list">
          <li>Equivalent to full user-level autonomy on this machine</li>
          <li>Deny rules and PreToolUse hooks still apply at the CLI layer</li>
          <li>You can turn this off any time in the sidebar</li>
          <li>Do not enable on untrusted repos or shared machines</li>
        </ul>
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Keep gated
          </button>
          <button type="button" className="btn btn-danger" onClick={onConfirm}>
            I understand, enable it
          </button>
        </div>
      </div>
    </div>
  )
}
