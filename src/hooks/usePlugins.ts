import { useCallback, useRef, useState } from 'react'
import type { MarketplaceSource, McpAddInput, McpServer, Plugin,
  InstalledSkill,
  SavedWorkflow
} from '../../shared/types'

/**
 * Plugins, marketplaces and MCP servers.
 *
 * Self-contained on purpose: nothing here reads the agent, the session or the
 * settings, and nothing outside writes this state. It is lazy: every call in
 * here hits the network or a marketplace git cache, so the panel that shows the
 * data is what asks for it, never the app's startup path.
 */
export function usePlugins() {
  const [installedPlugins, setInstalledPlugins] = useState<Plugin[]>([])
  const [availablePlugins, setAvailablePlugins] = useState<Plugin[]>([])
  const [marketplaces, setMarketplaces] = useState<MarketplaceSource[]>([])
  const [mcpServers, setMcpServers] = useState<McpServer[]>([])
  const [skills, setSkills] = useState<InstalledSkill[]>([])
  const [workflows, setWorkflows] = useState<SavedWorkflow[]>([])
  const [pluginsLoading, setPluginsLoading] = useState(false)
  const [pluginsError, setPluginsError] = useState<string | null>(null)
  const [pluginBusy, setPluginBusy] = useState<string | null>(null)
  const projectCwdRef = useRef<string | undefined>(undefined)

  const refreshPlugins = useCallback(async (projectCwd?: string | null) => {
    if (projectCwd !== undefined) {
      projectCwdRef.current = projectCwd || undefined
    }
    setPluginsLoading(true)
    setPluginsError(null)
    try {
      // Skills and workflows are read straight off disk, so they cost nothing
      // and never fail the way a CLI call can, but they are fetched together
      // so one refresh brings the whole panel up to date.
      const [inst, mkts, servers, skillList, workflowList] = await Promise.all([
        window.gronk.listInstalledPlugins(),
        window.gronk.listMarketplaces(),
        window.gronk.listMcpServers(),
        window.gronk.listSkills(),
        window.gronk.listWorkflows(projectCwdRef.current)
      ])
      setInstalledPlugins(inst)
      setMarketplaces(mkts)
      setMcpServers(servers)
      setSkills(skillList)
      setWorkflows(workflowList)
    } catch (err) {
      setPluginsError(err instanceof Error ? err.message : String(err))
    } finally {
      setPluginsLoading(false)
    }
  }, [])

  /** Slower: syncs marketplace git caches. Called on first open of the Marketplace tab. */
  const loadPluginCatalog = useCallback(async () => {
    setPluginsLoading(true)
    setPluginsError(null)
    try {
      setAvailablePlugins(await window.gronk.listAvailablePlugins())
    } catch (err) {
      setPluginsError(err instanceof Error ? err.message : String(err))
    } finally {
      setPluginsLoading(false)
    }
  }, [])

  const runPluginAction = useCallback(
    async (name: string, action: () => Promise<{ ok: boolean; message: string; plugins?: Plugin[] }>) => {
      setPluginBusy(name)
      setPluginsError(null)
      try {
        const res = await action()
        if (!res.ok) {
          setPluginsError(res.message)
          // Stop here. A failed command changed nothing, so there is nothing to
          // re-read, and refreshPlugins opens with setPluginsError(null), which
          // would erase the message set one line above and leave the user with a
          // failure they never got to read.
          return
        }
        if (res.plugins) setInstalledPlugins(res.plugins)
        else await refreshPlugins()
      } catch (err) {
        setPluginsError(err instanceof Error ? err.message : String(err))
      } finally {
        setPluginBusy(null)
      }
    },
    [refreshPlugins]
  )

  const installPlugin = useCallback(
    (source: string, trust: boolean) =>
      runPluginAction(source, () => window.gronk.installPlugin(source, trust)),
    [runPluginAction]
  )
  const enablePlugin = useCallback(
    (name: string) => runPluginAction(name, () => window.gronk.enablePlugin(name)),
    [runPluginAction]
  )
  const disablePlugin = useCallback(
    (name: string) => runPluginAction(name, () => window.gronk.disablePlugin(name)),
    [runPluginAction]
  )
  const uninstallPlugin = useCallback(
    (name: string) => runPluginAction(name, () => window.gronk.uninstallPlugin(name)),
    [runPluginAction]
  )

  const addMcpServer = useCallback(
    async (input: McpAddInput) => {
      setPluginBusy(input.name)
      setPluginsError(null)
      try {
        const res = await window.gronk.addMcpServer(input)
        if (!res.ok) setPluginsError(res.message)
        if (res.servers) setMcpServers(res.servers)
        else setMcpServers(await window.gronk.listMcpServers())
      } catch (err) {
        setPluginsError(err instanceof Error ? err.message : String(err))
      } finally {
        setPluginBusy(null)
      }
    },
    []
  )

  const removeMcpServer = useCallback(async (name: string) => {
    setPluginBusy(name)
    setPluginsError(null)
    try {
      const res = await window.gronk.removeMcpServer(name)
      if (!res.ok) setPluginsError(res.message)
      if (res.servers) setMcpServers(res.servers)
      else setMcpServers(await window.gronk.listMcpServers())
    } catch (err) {
      setPluginsError(err instanceof Error ? err.message : String(err))
    } finally {
      setPluginBusy(null)
    }
  }, [])

  return {
    skills,
    workflows,
    installedPlugins,
    availablePlugins,
    marketplaces,
    mcpServers,
    pluginsLoading,
    pluginsError,
    pluginBusy,
    refreshPlugins,
    loadPluginCatalog,
    installPlugin,
    enablePlugin,
    disablePlugin,
    uninstallPlugin,
    addMcpServer,
    removeMcpServer
  }
}
