import { useEffect, useRef, useState } from 'react'
import type { McpAddInput, McpServer, MarketplaceSource, Plugin,
  InstalledSkill
} from '../../shared/types'
import { McpServersPanel } from './McpServersPanel'
import { PluginCard } from './PluginCard'
import { PluginDetailsModal } from './PluginDetailsModal'
import { PluginTrustModal } from './PluginTrustModal'
import { plainText } from '../lib/plugin-view'

type Tab = 'installed' | 'skills' | 'marketplace' | 'mcp'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'installed', label: 'Installed' },
  { id: 'skills', label: 'Skills' },
  { id: 'marketplace', label: 'Marketplace' },
  { id: 'mcp', label: 'MCP servers' }
]

/** Case-insensitive match over the plain-text (sanitized) name/description/marketplace. */
function matches(plugin: Plugin, query: string): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    plainText(plugin.name, 120).toLowerCase().includes(q) ||
    plainText(plugin.description, 400).toLowerCase().includes(q) ||
    plainText(plugin.marketplace, 60).toLowerCase().includes(q)
  )
}

interface Props {
  open: boolean
  installed: Plugin[]
  available: Plugin[]
  marketplaces: MarketplaceSource[]
  mcpServers: McpServer[]
  skills: InstalledSkill[]
  loading: boolean
  error: string | null
  /** Name (or install source) of the entry with an action in flight */
  busyName: string | null
  onClose: () => void
  /** Fast: installed plugins + marketplaces + MCP servers */
  onRefresh: () => void
  /** Slower: syncs marketplace git caches */
  onLoadCatalog: () => void
  onInstall: (source: string, trust: boolean) => void
  onEnable: (name: string) => void
  onDisable: (name: string) => void
  onUninstall: (name: string) => void
  onAddMcp: (input: McpAddInput) => void
  onRemoveMcp: (name: string) => void
}

export function PluginsPanel({
  open,
  installed,
  available,
  marketplaces,
  mcpServers,
  skills,
  loading,
  error,
  busyName,
  onClose,
  onRefresh,
  onLoadCatalog,
  onInstall,
  onEnable,
  onDisable,
  onUninstall,
  onAddMcp,
  onRemoveMcp
}: Props) {
  const [tab, setTab] = useState<Tab>('installed')
  const [query, setQuery] = useState('')
  const [trustFor, setTrustFor] = useState<Plugin | null>(null)
  const [detailsFor, setDetailsFor] = useState<Plugin | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null)
  const catalogLoaded = useRef(false)

  // Latest-callback refs. Callers pass inline arrows, so the props get a new
  // identity every render; depending on them directly made the load effects
  // re-fire on their own state updates and spun into an infinite render loop.
  const refreshRef = useRef(onRefresh)
  const loadCatalogRef = useRef(onLoadCatalog)
  useEffect(() => {
    refreshRef.current = onRefresh
    loadCatalogRef.current = onLoadCatalog
  })

  useEffect(() => {
    if (open) refreshRef.current()
    // Re-syncing the catalog on every open would re-run git fetches; only the
    // explicit Refresh button in the Marketplace tab does that again.
    else catalogLoaded.current = false
  }, [open])

  useEffect(() => {
    if (!open || tab !== 'marketplace' || catalogLoaded.current) return
    catalogLoaded.current = true
    loadCatalogRef.current()
  }, [open, tab])

  if (!open) return null

  const list = tab === 'marketplace' ? available : installed
  const filtered = list.filter((p) => matches(p, query.trim()))
  const installedNames = new Set(installed.map((p) => p.name))
  // Re-read the open details entry from the live list so Enable/Disable results
  // show up without reopening the modal; fall back to the captured snapshot.
  const detailsPlugin = detailsFor
    ? installed.find((p) => p.name === detailsFor.name) || detailsFor
    : null

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Plugins and skills">
      <div className="modal plugins-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-modal-head">
          <h3>Plugins &amp; Skills</h3>
          <button
            type="button"
            className="btn-mini settings-close"
            onClick={onClose}
            aria-label="Close plugins"
          >
            Close
          </button>
        </div>

        <div className="plugins-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`plugins-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.id === 'installed' ? ` (${installed.length})` : null}
              {t.id === 'mcp' ? ` (${mcpServers.length})` : null}
              {t.id === 'skills' ? ` (${skills.length})` : null}
            </button>
          ))}
          <div className="plugins-tabs-spacer" />
          <button
            type="button"
            className="btn-mini"
            disabled={loading}
            onClick={() => (tab === 'marketplace' ? onLoadCatalog() : onRefresh())}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {error ? <p className="settings-hint warn-text plugins-error">{error}</p> : null}

        {tab === 'skills' ? (
          <div className="plugins-body">
            <p className="settings-hint">
              A skill is a folder containing SKILL.md. Drop one into{' '}
              <code className="path-inline">~/.grok/skills</code> and it appears here. That
              is the whole install. Bundled skills ship with the Grok CLI.
            </p>
            {skills.length === 0 ? (
              <div className="browse-empty">No skills found.</div>
            ) : (
              <div className="skill-list">
                {skills.map((skill) => (
                  <div key={`${skill.source}:${skill.directory}`} className="skill-row">
                    <div className="skill-head">
                      <span className="plugin-name">{plainText(skill.name, 80)}</span>
                      <span className={`plugin-chip ${skill.source === 'user' ? 'hot' : ''}`}>
                        {skill.source === 'user' ? 'yours' : 'bundled'}
                      </span>
                    </div>
                    <p className="plugin-desc">
                      {plainText(skill.description) || 'No description provided.'}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : tab === 'mcp' ? (
          <div className="plugins-body">
            <McpServersPanel
              servers={mcpServers}
              busyName={busyName}
              onAdd={onAddMcp}
              onRemove={onRemoveMcp}
            />
          </div>
        ) : (
          <div className="plugins-body">
            <input
              className="model-select plugins-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter by name or description"
              spellCheck={false}
              autoComplete="off"
              aria-label="Filter plugins"
            />

            {tab === 'marketplace' ? (
              <p className="settings-hint">
                {marketplaces.length === 0
                  ? 'No marketplaces configured. Add one with grok plugin marketplace add <source>.'
                  : `Sources: ${marketplaces
                      .map((m) => plainText(m.name, 40))
                      .filter(Boolean)
                      .join(' · ')}`}
              </p>
            ) : null}

            {loading && filtered.length === 0 ? (
              <div className="muted-note">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="muted-note">
                {tab === 'marketplace'
                  ? query
                    ? 'No catalog entries match that filter.'
                    : 'No catalog entries found.'
                  : 'No plugins installed yet. Check the Marketplace tab.'}
              </div>
            ) : (
              <div className="plugin-grid">
                {filtered.map((p) => (
                  <PluginCard
                    key={`${p.marketplace || 'local'}:${p.name}`}
                    plugin={p}
                    busy={busyName === p.name || busyName === p.sourceUrl}
                    onInstall={
                      installedNames.has(p.name) ? undefined : (plugin) => setTrustFor(plugin)
                    }
                    onDetails={(plugin) =>
                      // Catalog entries get the install-shaped trust modal; anything
                      // already on disk gets the read-only details modal. A catalog
                      // row whose name is already installed keeps status 'available',
                      // so match on the installed set too. Otherwise Details offers
                      // "Trust & install" for something the user already has.
                      plugin.status === 'available' && !installedNames.has(plugin.name)
                        ? setTrustFor(plugin)
                        : setDetailsFor(installed.find((i) => i.name === plugin.name) ?? plugin)
                    }
                    onEnable={onEnable}
                    onDisable={onDisable}
                    onUninstall={(name) => setConfirmUninstall(name)}
                  />
                ))}
              </div>
            )}

            <p className="settings-hint">
              Plugin names and descriptions come from third-party catalogs and are shown as inert
              text. Installing one runs its code on your machine with your permissions.
            </p>
          </div>
        )}

        <PluginTrustModal
          open={trustFor !== null}
          plugin={trustFor}
          busy={busyName !== null}
          onCancel={() => setTrustFor(null)}
          onConfirm={(source, trust) => {
            setTrustFor(null)
            onInstall(source, trust)
          }}
        />

        <PluginDetailsModal
          open={detailsPlugin !== null}
          plugin={detailsPlugin}
          busy={busyName !== null}
          onClose={() => setDetailsFor(null)}
          onEnable={onEnable}
          onDisable={onDisable}
          onUninstall={(name) => {
            setDetailsFor(null)
            setConfirmUninstall(name)
          }}
        />

        {confirmUninstall ? (
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <div className="modal modal-danger">
              <h3>Uninstall {plainText(confirmUninstall, 60)}?</h3>
              <p className="settings-hint">
                Removes the plugin and everything it contributed: skills, commands, agents, hooks
                and MCP servers. To keep it but stop it running, use Disable instead.
              </p>
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setConfirmUninstall(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    const name = confirmUninstall
                    setConfirmUninstall(null)
                    onUninstall(name)
                  }}
                >
                  Uninstall
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
