/**
 * Plugins, skills and MCP server IPC.
 *
 * Read paths are CLI-local (git/config, not xAI-account scoped) so they are
 * not auth-gated; every mutating handler calls assertAuthenticated() first.
 * Trust is never implied — installPlugin receives an explicit boolean that
 * the UI may only set from a human-confirmed trust modal.
 */

import { ipcMain } from 'electron'
import { assertAuthenticated } from '../auth'
import { assertTrustedSender } from '../ipc-guard'
import {
  addMcpServer,
  disablePlugin,
  enablePlugin,
  installPlugin,
  listAvailablePlugins,
  listInstalledPlugins,
  listMarketplaces,
  listMcpServers,
  mcpDoctor,
  removeMcpServer,
  uninstallPlugin,
  listSkills
} from '../plugins'
import { listWorkflows } from '../workflows'
import {
  assertCliName,
  assertCliToken,
  assertMcpTransport,
  assertOptionalString,
  assertOptionalStringArray,
  assertOptionalStringRecord,
  ENV_KEY_RE,
  HEADER_NAME_RE,
  PROJECT_SCOPE_UNSUPPORTED
} from './validate'
import type { McpAddInput, McpScope } from '../../../shared/types'

export function registerPluginsIpc(): void {
  ipcMain.handle('gronk:plugin-list', async (e) => {
    assertTrustedSender(e)
    return listInstalledPlugins()
  })

  ipcMain.handle('gronk:plugin-available', async (e) => {
    assertTrustedSender(e)
    return listAvailablePlugins()
  })

  ipcMain.handle('gronk:plugin-marketplaces', async (e) => {
    assertTrustedSender(e)
    return listMarketplaces()
  })

  ipcMain.handle('gronk:list-skills', async (e) => {
    assertTrustedSender(e)
    return listSkills()
  })

  ipcMain.handle('gronk:list-workflows', async (e, projectCwd?: unknown) => {
    assertTrustedSender(e)
    const cwd = assertOptionalString(projectCwd, 'cwd')
    return listWorkflows(cwd)
  })

  ipcMain.handle('gronk:plugin-install', async (e, source: unknown, trust: unknown) => {
    assertTrustedSender(e)
    // A source may be a git URL, user/repo@ref#subdir, or a local path (spaces
    // allowed) — only a leading '-' and control characters are rejected.
    const src = assertCliToken(source, 'source')
    if (typeof trust !== 'boolean') throw new Error('Invalid trust flag: expected boolean')
    await assertAuthenticated()
    return installPlugin(src, trust)
  })

  ipcMain.handle('gronk:plugin-enable', async (e, name: unknown) => {
    assertTrustedSender(e)
    const pluginName = assertCliName(name, 'name')
    await assertAuthenticated()
    return enablePlugin(pluginName)
  })

  ipcMain.handle('gronk:plugin-disable', async (e, name: unknown) => {
    assertTrustedSender(e)
    const pluginName = assertCliName(name, 'name')
    await assertAuthenticated()
    return disablePlugin(pluginName)
  })

  ipcMain.handle('gronk:plugin-uninstall', async (e, name: unknown) => {
    assertTrustedSender(e)
    const pluginName = assertCliName(name, 'name')
    await assertAuthenticated()
    return uninstallPlugin(pluginName)
  })

  ipcMain.handle('gronk:mcp-list', async (e) => {
    assertTrustedSender(e)
    return listMcpServers()
  })

  ipcMain.handle('gronk:mcp-add', async (e, input: unknown) => {
    assertTrustedSender(e)
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Invalid MCP server input: expected an object')
    }
    const raw = input as Record<string, unknown>
    // MVP: user scope only (spec §5) — the spawn helper has no validated
    // project cwd, so `-s project` would target Gronk's own directory.
    if (raw.scope === 'project') throw new Error(PROJECT_SCOPE_UNSUPPORTED)
    if (raw.scope !== 'user') throw new Error("Invalid scope: expected 'user' or 'project'")
    const payload: McpAddInput = {
      name: assertCliName(raw.name, 'name'),
      commandOrUrl: assertCliToken(raw.commandOrUrl, 'commandOrUrl'),
      transport: assertMcpTransport(raw.transport),
      scope: 'user',
      args: assertOptionalStringArray(raw.args, 'args'),
      env: assertOptionalStringRecord(raw.env, 'env', ENV_KEY_RE),
      headers: assertOptionalStringRecord(raw.headers, 'headers', HEADER_NAME_RE)
    }
    await assertAuthenticated()
    return addMcpServer(payload)
  })

  ipcMain.handle('gronk:mcp-remove', async (e, name: unknown, scope?: unknown) => {
    assertTrustedSender(e)
    const serverName = assertCliName(name, 'name')
    const rawScope = assertOptionalString(scope, 'scope')
    if (rawScope === 'project') throw new Error(PROJECT_SCOPE_UNSUPPORTED)
    if (rawScope !== undefined && rawScope !== 'user') {
      throw new Error("Invalid scope: expected 'user' or 'project'")
    }
    const mcpScope: McpScope | undefined = rawScope === 'user' ? 'user' : undefined
    await assertAuthenticated()
    return removeMcpServer(serverName, mcpScope)
  })

  // Gated with its neighbours. It writes no config, which is what makes it look
  // like one of the read-only handlers above, but it dials the configured
  // servers and starts the stdio ones, so it runs third-party code the same way
  // install and enable do.
  //
  // After the argument checks and before the call, the same order as the rest:
  // validating first means a malformed request never reaches the auth probe,
  // which spawns the CLI and hits the network on its own account.
  ipcMain.handle('gronk:mcp-doctor', async (e, name?: unknown) => {
    assertTrustedSender(e)
    const rawName = assertOptionalString(name, 'name')
    const serverName = rawName === undefined ? undefined : assertCliName(rawName, 'name')
    await assertAuthenticated()
    return mcpDoctor(serverName)
  })
}
