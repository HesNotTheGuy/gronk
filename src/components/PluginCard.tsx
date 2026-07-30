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

  return (
    <div className={`plugin-card ${busy ? 'busy' : ''}`}>
      <div className="plugin-card-head">
        <span className="plugin-name" title={name}>
          {name}
        </span>
        {plugin.version ? (
          <span className="plugin-chip">v{plainText(plugin.version, 24)}</span>
        ) : null}
        {/*
          The marketplace NAME is a string from a config file — anyone can set it
          to "xAI Official". It is shown as a plain chip with no authority
          styling, and the origin below is what a user should actually read.
        */}
        {plugin.marketplace ? (
          <span className="plugin-chip">{plainText(plugin.marketplace, 40)}</span>
        ) : null}
        {origin ? (
          <span
            className="plugin-origin"
            title={`Published from ${origin}. The name beside it is self-declared; this is not.`}
          >
            {origin}
          </span>
        ) : null}
        {plugin.category ? (
          <span className="plugin-chip">{plainText(plugin.category, 32)}</span>
        ) : null}
        {!available ? (
          <span className={`plugin-state ${isDisabled ? 'off' : 'on'}`}>
            {isDisabled ? 'Disabled' : 'Enabled'}
          </span>
        ) : null}
      </div>

      <p className="plugin-desc" title={description}>
        {description || 'No description provided.'}
      </p>

      <div className="plugin-counts" aria-label="Components declared by this plugin">
        <span className="plugin-count">Skills {counts.skills}</span>
        <span className="plugin-count">Cmds {counts.commands}</span>
        <span className="plugin-count">Agents {counts.agents}</span>
        <span className={`plugin-count ${counts.mcp > 0 ? 'hot' : ''}`}>MCP {counts.mcp}</span>
        <span className={`plugin-count ${counts.hooks > 0 ? 'hot' : ''}`}>
          Hooks {counts.hooks}
        </span>
      </div>

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
                : 'Inspect what this plugin contains — read only'
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
                : 'Already installed — see the Installed tab to disable or remove it'
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
            title="Reversible kill-switch — neutralizes hooks and MCP servers without deleting"
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
