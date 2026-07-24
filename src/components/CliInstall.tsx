interface Props {
  open: boolean
  platform: string
  installing: boolean
  /** Result message after an install attempt (success or error), or null before */
  result: string | null
  onInstall: () => void
  onClose: () => void
}

function installCommand(platform: string): string {
  return platform === 'win32'
    ? 'irm https://x.ai/cli/install.ps1 | iex'
    : 'curl -fsSL https://x.ai/cli/install.sh | bash'
}

/**
 * User-consented Grok CLI installer. Shows the exact official command before
 * running it — never installs silently. Runs xAI's installer from x.ai.
 */
export function CliInstall({ open, platform, installing, result, onInstall, onClose }: Props) {
  if (!open) return null
  const cmd = installCommand(platform)

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h3>Install the Grok CLI</h3>

        {installing ? (
          <div className="cli-install-running">
            <span className="cli-spinner" aria-hidden />
            <div>
              <strong>Installing…</strong>
              <p className="settings-hint">
                Running the official installer — this can take a minute. Don&apos;t close Grocky.
              </p>
            </div>
          </div>
        ) : result ? (
          <>
            <p className="settings-hint">{result}</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Grocky can install the Grok CLI for you using xAI&apos;s official installer. It runs a
              script from <strong>x.ai</strong> over HTTPS and installs the <code>grok</code> binary
              on your computer.
            </p>
            <p className="settings-hint warn-text">
              This runs an installer script on your machine. Proceed only if you trust the source (the
              official xAI CLI).
            </p>
            <div className="cli-install-cmd">
              <div className="section-label">Command</div>
              <code className="path-code">{cmd}</code>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={onInstall}>
                Install
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
