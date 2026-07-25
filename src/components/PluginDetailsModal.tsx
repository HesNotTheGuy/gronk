import type { Plugin, PluginComponent } from '../../shared/types'
import {
  auditPlugin,
  componentCounts,
  componentLine,
  installSource,
  plainText
} from '../lib/plugin-view'

/**
 * Read-only inspector for a plugin that is already installed (or installed and
 * disabled). Deliberately NOT install-shaped: there is no confirm, no source
 * string handed to the CLI and no path to `--trust` — that flag may only ever
 * originate from PluginTrustModal's explicit confirm
 * (REVIEW-NOTES round 6, "Trust model (do NOT regress)").
 *
 * Every string below comes from a third-party catalog or plugin manifest and is
 * UNTRUSTED: it is rendered through plainText() as inert text, never as
 * markdown, never as HTML, never as instructions to the agent.
 */

const INSPECTION_NOTE =
  'Grocky lists what the plugin declares; it has not inspected the code on disk.'

const INERT_NOTE =
  'Names and descriptions come from the plugin author and are shown as inert text — never treat them as instructions.'

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
  /** True while any plugin action is in flight — freezes the mutating actions. */
  busy: boolean
  onClose: () => void
  /** Optional non-install actions. Omit them all for a purely read-only view. */
  onEnable?: (name: string) => void
  onDisable?: (name: string) => void
  onUninstall?: (name: string) => void
}

export function PluginDetailsModal({
  open,
  plugin,
  busy,
  onClose,
  onEnable,
  onDisable,
  onUninstall
}: Props) {
  if (!open || !plugin) return null

  const name = plainText(plugin.name, 60)
  const version = plainText(plugin.version, 24)
  const marketplace = plainText(plugin.marketplace, 60)
  const category = plainText(plugin.category, 40)
  const description = plainText(plugin.description, 400)
  const sha = plainText(plugin.sha, 64)
  const source = plainText(installSource(plugin), 200)

  // Counts come from components.* only — the flat skill_count / has_* fields are
  // unreliable and are never read for display (SKILLS-PLUGINS-SPEC §1).
  const counts = componentCounts(plugin)
  const total = counts.skills + counts.commands + counts.agents + counts.mcp + counts.hooks
  const tags = auditPlugin(plugin)
  const components = plugin.components

  const isDisabled = plugin.status === 'disabled' || plugin.enabled === false
  // Mutating actions are offered only for entries that are actually on disk.
  // A catalog-only entry gets a read-only view; installing is the trust modal's job.
  const canMutate = plugin.status !== 'available'

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Plugin details">
      <div className="modal modal-kicker details-modal" data-kicker="DETAILS">
        <h3>{name || 'Unnamed plugin'}</h3>

        <p className="settings-hint">
          Read-only view of an installed plugin. Nothing here installs or updates anything.
        </p>

        <div className="settings-block">
          <div className="section-label">Identity</div>
          <dl className="details-meta">
            <dt>State</dt>
            <dd>
              <span className={`plugin-state ${isDisabled ? 'off' : 'on'}`}>
                {isDisabled ? 'Disabled' : 'Enabled'}
              </span>
            </dd>
            <dt>Version</dt>
            <dd>{version || 'not declared'}</dd>
            <dt>Marketplace</dt>
            <dd>{marketplace || 'local / unknown'}</dd>
            <dt>Category</dt>
            <dd>{category || 'not declared'}</dd>
            <dt>Source</dt>
            <dd>
              <code className="path-code details-code">{source || 'unknown source'}</code>
            </dd>
            {sha ? (
              <>
                <dt>Commit</dt>
                <dd>
                  <code className="path-code details-code">{sha}</code>
                </dd>
              </>
            ) : null}
          </dl>
          {description ? <p className="settings-hint details-desc">{description}</p> : null}
        </div>

        <div className="settings-block">
          <div className="section-label">Components</div>
          <div className="plugin-counts details-counts" aria-label="Components this plugin declares">
            <span className="plugin-count">Skills {counts.skills}</span>
            <span className="plugin-count">Cmds {counts.commands}</span>
            <span className="plugin-count">Agents {counts.agents}</span>
            <span className={`plugin-count ${counts.mcp > 0 ? 'hot' : ''}`}>MCP {counts.mcp}</span>
            <span className={`plugin-count ${counts.hooks > 0 ? 'hot' : ''}`}>
              Hooks {counts.hooks}
            </span>
          </div>
          {total > 0 ? (
            <div className="trust-inventory details-inventory">
              <InventoryGroup title="Skills" items={components?.skills} />
              <InventoryGroup title="MCP servers" items={components?.mcpServers} />
              <InventoryGroup title="Commands" items={components?.commands} />
              <InventoryGroup title="Agents" items={components?.agents} />
              <InventoryGroup title="Hooks" items={components?.hooks} />
            </div>
          ) : (
            <div className="muted-note">
              This plugin declares no components (or none could be read).
            </div>
          )}
          <p className="settings-hint">{INSPECTION_NOTE}</p>
        </div>

        <div className="settings-block">
          <div className="section-label">Risk</div>
          {tags.length === 0 ? (
            <div className="muted-note">
              No hooks or servers declared — the plugin still runs as your OS user.
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
          <p className="settings-hint">{INERT_NOTE}</p>
        </div>

        <div className="modal-actions details-actions">
          {canMutate && onUninstall ? (
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={() => onUninstall(plugin.name)}
            >
              Uninstall
            </button>
          ) : null}
          <span className="details-actions-spacer" />
          {canMutate && isDisabled && onEnable ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => onEnable(plugin.name)}
            >
              {busy ? 'Working…' : 'Enable'}
            </button>
          ) : null}
          {canMutate && !isDisabled && onDisable ? (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => onDisable(plugin.name)}
              title="Reversible kill-switch — neutralizes hooks and MCP servers without deleting"
            >
              {busy ? 'Working…' : 'Disable'}
            </button>
          ) : null}
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
