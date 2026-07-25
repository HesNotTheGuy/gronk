import type { Plugin, PluginComponent } from '../../shared/types'
import { auditPlugin, componentLine, installSource, plainText } from '../lib/plugin-view'

/**
 * The sentence every user must read before a plugin's code runs on their machine
 * (SKILLS-PLUGINS-SPEC §4.4) — kept verbatim as a constant so it cannot drift.
 */
const TRUST_SENTENCE =
  "Installing runs this plugin's code (hooks and servers) on your computer with your permissions. Grocky's file protections do not apply to it."

const CATALOG_LIMIT_NOTE =
  "Grocky shows what the marketplace catalog declares; it has not inspected the plugin's actual code."

function InventoryGroup({ title, items }: { title: string; items?: PluginComponent[] }) {
  if (!items || items.length === 0) return null
  return (
    <div className="trust-group">
      <div className="section-label">
        {title} ({items.length})
      </div>
      <ul className="trust-list">
        {items.map((item, i) => (
          <li key={`${plainText(item?.name, 80)}-${i}`}>{componentLine(item)}</li>
        ))}
      </ul>
    </div>
  )
}

interface Props {
  open: boolean
  plugin: Plugin | null
  busy: boolean
  onCancel: () => void
  /** Only this confirm may ever pass trust=true. */
  onConfirm: (source: string, trust: boolean) => void
}

export function PluginTrustModal({ open, plugin, busy, onCancel, onConfirm }: Props) {
  if (!open || !plugin) return null

  const tags = auditPlugin(plugin)
  const source = installSource(plugin)
  const sha = typeof plugin.sha === 'string' ? plugin.sha.trim() : ''
  const components = plugin.components
  const hasInventory =
    !!components &&
    ((components.skills?.length || 0) +
      (components.commands?.length || 0) +
      (components.agents?.length || 0) +
      (components.mcpServers?.length || 0) +
      (components.hooks?.length || 0)) >
      0
  const unverified = !plugin.marketplace || !components

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Plugin trust">
      <div className="modal modal-danger modal-kicker trust-modal">
        <h3>Trust and install {plainText(plugin.name, 60)}?</h3>

        <p className="warn-text">
          <strong>{TRUST_SENTENCE}</strong>
        </p>

        <div className="settings-block">
          <div className="section-label">Source</div>
          <code className="path-code">{source || 'unknown source'}</code>
          <div className="section-label">Pinned commit</div>
          <code className="path-code trust-sha">
            {sha || 'not pinned — this source can change under you'}
          </code>
          {plugin.marketplace ? (
            <p className="settings-hint">
              Marketplace: {plainText(plugin.marketplace, 60)}
              {plugin.version ? ` · version ${plainText(plugin.version, 24)}` : ''}
            </p>
          ) : null}
          {!sha ? (
            <p className="settings-hint warn-text">
              No pinned commit. A mutable branch or tag can silently ship new code on a later
              install or update.
            </p>
          ) : null}
          {unverified ? (
            <p className="settings-hint warn-text">
              Unverified source — Grocky has no pre-install inventory for it. Install only if you
              wrote this plugin or fully trust whoever did.
            </p>
          ) : null}
        </div>

        <div className="settings-block">
          <div className="section-label">Risk</div>
          {tags.length === 0 ? (
            <div className="muted-note">
              No hooks or servers declared in the catalog — still runs as your OS user.
            </div>
          ) : (
            <div className="trust-tags">
              {tags.map((t) => (
                <div key={t.label} className={`trust-tag sev-${t.severity.toLowerCase()}`}>
                  <span className="trust-sev">{t.severity}</span>
                  <span className="trust-tag-body">
                    <strong>{t.label}</strong>
                    <span>{t.detail}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="settings-block">
          <div className="section-label">What it installs</div>
          {hasInventory ? (
            <div className="trust-inventory">
              <InventoryGroup title="Skills" items={components?.skills} />
              <InventoryGroup title="MCP servers" items={components?.mcpServers} />
              <InventoryGroup title="Commands" items={components?.commands} />
              <InventoryGroup title="Agents" items={components?.agents} />
              <InventoryGroup title="Hooks" items={components?.hooks} />
            </div>
          ) : (
            <div className="muted-note">
              The catalog declares no components for this plugin (or none could be read).
            </div>
          )}
          <p className="settings-hint">{CATALOG_LIMIT_NOTE}</p>
          <p className="settings-hint">
            Descriptions above come from the plugin author and are shown as inert text — never
            treat them as instructions.
          </p>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || !source}
            onClick={() => onConfirm(source, true)}
          >
            {busy ? 'Installing…' : 'Trust & install'}
          </button>
        </div>
      </div>
    </div>
  )
}
