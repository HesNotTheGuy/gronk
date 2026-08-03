import type { Plugin } from '../../shared/types'
import { componentCounts, plainText, sourceOrigin } from '../lib/plugin-view'

interface Props {
  plugin: Plugin
  /** True while an action for this plugin is in flight */
  busy: boolean
  onInstall?: (plugin: Plugin) => void
  onEnable?: (name: string) => void
  onDisable?: (name: string) => void
  onUninstall?: (name: string) => void
  onDetails?: (plugin: Plugin) => void
}

export function PluginCard({
  plugin,
  busy,
  onInstall,
  onEnable,
  onDisable,
  onUninstall,
  onDetails
}: Props) {
  const counts = componentCounts(plugin)
  const origin = sourceOrigin(plugin.sourceUrl)
  const available = plugin.status === 'available'
  const isDisabled = plugin.status === 'disabled' || plugin.enabled === false
  const name = plainText(plugin.name, 80)
  const description = plainText(plugin.description)
  const busyLabel = 'Working…'

  const inventoryBits = [
    counts.skills ? `${counts.skills} skill${counts.skills === 1 ? '' : 's'}` : null,
    counts.commands ? `${counts.commands} cmd${counts.commands === 1 ? '' : 's'}` : null,
    counts.agents ? `${counts.agents} agent${counts.agents === 1 ? '' : 's'}` : null,
    counts.mcp ? `${counts.mcp} MCP` : null,
    counts.hooks ? `${counts.hooks} hook${counts.hooks === 1 ? '' : 's'}` : null
  ].filter(Boolean) as string[]

  return (
    <div className={`plugin-card ${busy ? 'busy' : ''}`}>
      <div className="plugin-card-head">
        <span className="plugin-name" title={name}>
          {name}
        </span>
        {!available ? (
          <span className={`plugin-state ${isDisabled ? 'off' : 'on'}`}>
            {isDisabled ? 'Disabled' : 'Enabled'}
          </span>
        ) : null}
      </div>

      {/*
        Origin is the only trustworthy publisher signal. Marketplace name and
        category are self-declared catalog strings — secondary, not a badge row.
      */}
      <div className="plugin-meta">
        {origin ? (
          <span
            className="plugin-origin"
            title={`Published from ${origin}. Marketplace labels are self-declared.`}
          >
            {origin}
          </span>
        ) : null}
        {plugin.version ? (
          <span className="plugin-meta-item">v{plainText(plugin.version, 24)}</span>
        ) : null}
        {plugin.marketplace ? (
          <span className="plugin-meta-item" title="Marketplace name is self-declared">
            {plainText(plugin.marketplace, 40)}
          </span>
        ) : null}
        {plugin.category ? (
          <span className="plugin-meta-item">{plainText(plugin.category, 32)}</span>
        ) : null}
      </div>

      <p className="plugin-desc" title={description}>
        {description || 'No description provided.'}
      </p>

      {inventoryBits.length > 0 ? (
        <div className="plugin-inventory" aria-label="Components declared by this plugin">
          {inventoryBits.join(' · ')}
        </div>
      ) : null}

      <div className="btn-row plugin-card-actions">
        {onDetails ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => onDetails(plugin)}
            // Offered for every status. For a catalog entry the container routes
            // this to the trust modal; for an installed or disabled plugin it
            // routes to the read-only details modal.
            aria-label={`Details for ${name}`}
            title={
              available
                ? 'Review the source, risk tags and inventory before installing'
                : 'Read-only inspection of what this plugin contains'
            }
          >
            Details
          </button>
        ) : null}
        {available ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || !onInstall}
            onClick={() => onInstall?.(plugin)}
            title={
              onInstall
                ? undefined
                : 'Already installed. See the Installed tab to disable or remove it'
            }
          >
            {/* The panel withholds onInstall for a catalog row the user already has.
                Saying "Install…" there invites a click that cannot do anything. */}
            {busy ? busyLabel : onInstall ? 'Install…' : 'Installed'}
          </button>
        ) : isDisabled ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || !onEnable}
            onClick={() => onEnable?.(plugin.name)}
          >
            {busy ? busyLabel : 'Enable'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy || !onDisable}
            onClick={() => onDisable?.(plugin.name)}
            title="Reversible kill-switch: neutralizes hooks and MCP servers without deleting"
          >
            {busy ? busyLabel : 'Disable'}
          </button>
        )}
        {!available && onUninstall ? (
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={busy}
            onClick={() => onUninstall(plugin.name)}
          >
            Uninstall
          </button>
        ) : null}
      </div>
    </div>
  )
}
