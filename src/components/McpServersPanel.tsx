import { useState } from 'react'
import type { FormEvent } from 'react'
import type { McpAddInput, McpServer, McpTransport } from '../../shared/types'
import { plainText } from '../lib/plugin-view'

/** Same shape the main process enforces: reject anything that could be read as a CLI flag. */
const NAME_RE = new RegExp('^[A-Za-z0-9._@/-]+$')

const TRANSPORTS: Array<{ id: McpTransport; label: string; hint: string }> = [
  { id: 'stdio', label: 'stdio (local command)', hint: 'Runs a local program on your machine' },
  { id: 'http', label: 'http (remote)', hint: 'Sends data to a remote endpoint' },
  { id: 'sse', label: 'sse (remote)', hint: 'Sends data to a remote endpoint' }
]

interface Props {
  servers: McpServer[]
  /** Name of the server currently being added/removed, or null */
  busyName: string | null
  onAdd: (input: McpAddInput) => void
  onRemove: (name: string) => void
}

export function McpServersPanel({ servers, busyName, onAdd, onRemove }: Props) {
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [commandOrUrl, setCommandOrUrl] = useState('')
  const [transport, setTransport] = useState<McpTransport>('stdio')
  const [formError, setFormError] = useState<string | null>(null)

  const anyBusy = busyName !== null

  function reset(): void {
    setName('')
    setCommandOrUrl('')
    setTransport('stdio')
    setFormError(null)
  }

  function submit(e: FormEvent): void {
    e.preventDefault()
    const n = name.trim()
    const target = commandOrUrl.trim()
    if (!n || !NAME_RE.test(n)) {
      setFormError('Name may only contain letters, numbers and . _ @ / -')
      return
    }
    if (n.startsWith('-')) {
      setFormError('Name must not start with "-"')
      return
    }
    if (!target) {
      setFormError(transport === 'stdio' ? 'Enter a command to run' : 'Enter a URL')
      return
    }
    if (target.startsWith('-')) {
      setFormError('Command or URL must not start with "-"')
      return
    }
    const lower = target.toLowerCase()
    if (transport !== 'stdio' && !lower.startsWith('http://') && !lower.startsWith('https://')) {
      setFormError('Remote transports need an http:// or https:// URL')
      return
    }
    if (servers.some((s) => s.name === n)) {
      setFormError('A server with that name already exists')
      return
    }
    setFormError(null)
    // MVP: user scope only. The CLI helper has no cwd, so -s project would write into
    // Gronk's own directory instead of the project (SKILLS-PLUGINS-SPEC §5).
    onAdd({ name: n, commandOrUrl: target, transport, scope: 'user' })
    reset()
    setShowForm(false)
  }

  return (
    <div className="mcp-panel">
      <div className="section-label">Configured servers ({servers.length})</div>

      {servers.length === 0 ? (
        <div className="muted-note">No MCP servers configured</div>
      ) : (
        <div className="mcp-list">
          {servers.map((s) => {
            const busy = busyName === s.name
            const status = s.status || 'unknown'
            return (
              <div key={`${s.scope}:${s.name}`} className="mcp-row">
                <span
                  className={`mcp-dot ${status}`}
                  title={plainText(s.detail, 160) || `Status: ${status}`}
                  aria-label={`Status: ${status}`}
                />
                <span className="mcp-name" title={plainText(s.name, 80)}>
                  {plainText(s.name, 80)}
                </span>
                <span className="plugin-chip">{plainText(s.transport, 12) || 'stdio'}</span>
                <span className="plugin-chip">{plainText(s.scope, 12) || 'user'}</span>
                <span className="mcp-target" title={plainText(s.commandOrUrl, 200)}>
                  {plainText(s.commandOrUrl, 200) || '—'}
                </span>
                <button
                  type="button"
                  className="btn-mini danger"
                  disabled={busy || anyBusy}
                  onClick={() => onRemove(s.name)}
                >
                  {busy ? 'Working…' : 'Remove'}
                </button>
              </div>
            )
          })}
        </div>
      )}

      <p className="settings-hint">
        Values shown here are redacted by Gronk. Environment variables and auth headers set on a
        server are never displayed in full. MCP servers run as processes on your machine, outside
        Gronk&apos;s file protections.
      </p>

      {showForm ? (
        <form className="mcp-form" onSubmit={submit}>
          <div className="section-label">Add server</div>

          <label className="mcp-field">
            <span>Name</span>
            <input
              className="model-select"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-server"
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="mcp-field">
            <span>{transport === 'stdio' ? 'Command' : 'URL'}</span>
            <input
              className="model-select"
              value={commandOrUrl}
              onChange={(e) => setCommandOrUrl(e.target.value)}
              placeholder={transport === 'stdio' ? 'mcp-server-binary' : 'https://example.com/mcp'}
              spellCheck={false}
              autoComplete="off"
            />
          </label>

          <label className="mcp-field">
            <span>Transport</span>
            <select
              className="model-select"
              value={transport}
              onChange={(e) => setTransport(e.target.value as McpTransport)}
            >
              {TRANSPORTS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          <label className="mcp-field">
            <span>Scope</span>
            <select className="model-select" value="user" disabled>
              <option value="user">user (~/.grok)</option>
            </select>
          </label>

          <p className="settings-hint">
            {TRANSPORTS.find((t) => t.id === transport)?.hint} · Project scope is coming later.
            Servers added here apply to every project.
          </p>
          <p className="settings-hint">
            Secrets are not entered here. Configure environment variables and auth headers with{' '}
            <code>grok mcp add</code> so tokens never pass through Gronk.
          </p>

          {formError ? <p className="settings-hint warn-text">{formError}</p> : null}

          <div className="btn-row">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                reset()
                setShowForm(false)
              }}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-secondary btn-sm" disabled={anyBusy}>
              {anyBusy ? 'Working…' : 'Add server'}
            </button>
          </div>
        </form>
      ) : (
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={anyBusy}
            onClick={() => setShowForm(true)}
          >
            Add server…
          </button>
        </div>
      )}
    </div>
  )
}
