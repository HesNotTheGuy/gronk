import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { mount, flush } from './helpers/render'
import { installFakeBridge } from './helpers/gronk-api'

/**
 * `useGronk` is what every component in the app talks to. This pins the exact
 * set of members it returns.
 *
 * The point is the refactor: the hook is being split into focused hooks that
 * compose back into one object, and the way that goes wrong is silently losing
 * a member. Nothing else catches that — TypeScript is happy, the build is happy,
 * and a screen quietly stops working.
 *
 * When a member is intentionally added or removed, update EXPECTED_MEMBERS in
 * the same commit. A diff here should always be deliberate.
 */

const EXPECTED_MEMBERS: string[] = [
  "activePlan",
  "addMcpServer",
  "agentSurface",
  "archiveSession",
  "archivedSessions",
  "audit",
  "auth",
  "authBusy",
  "authMessage",
  "availablePlugins",
  "browsing",
  "busy",
  "cancel",
  "cancelYolo",
  "changeModel",
  "changePermissionMode",
  "chatSessions",
  "chatWorkspacePath",
  "chooseDataDir",
  "clearBinary",
  "cliInstallResult",
  "cliInstalling",
  "confirmYolo",
  "connection",
  "copyExportPath",
  "cwd",
  "dataBusy",
  "dataError",
  "dataLocation",
  "dataNotice",
  "deleteSession",
  "deviceHint",
  "disablePlugin",
  "dismissExport",
  "dismissStoreHealth",
  "enablePlugin",
  "error",
  "exportNotice",
  "exportSession",
  "goChat",
  "goHome",
  "goProjects",
  "grokPath",
  "health",
  "historySource",
  "installCli",
  "installPlugin",
  "installedPlugins",
  "isAuthenticated",
  "loadPluginCatalog",
  "login",
  "logout",
  "marketplaces",
  "mcpServers",
  "messages",
  "models",
  "moveDataDir",
  "newChat",
  "openChat",
  "openProject",
  "permission",
  "permissionMode",
  "pickBinary",
  "planCollapsed",
  "pluginBusy",
  "pluginsError",
  "pluginsLoading",
  "previewError",
  "previewRunning",
  "previewUrl",
  "projectName",
  "projectOnlySessions",
  "recentProjects",
  "refreshAuth",
  "refreshHealth",
  "refreshMeta",
  "refreshPlugins",
  "removeMcpServer",
  "renameSession",
  "resetDataDir",
  "respondPermission",
  "retryPrompt",
  "revealExport",
  "scrollRef",
  "selectSession",
  "sendPrompt",
  "sessionId",
  "sessions",
  "setCliInstallResult",
  "setError",
  "setPlanCollapsed",
  "setShowArchived",
  "setShowCliInstall",
  "setShowSettings",
  "settings",
  "showArchived",
  "showCliInstall",
  "showSettings",
  "showYoloConfirm",
  "startPreview",
  "stopPreview",
  "storeHealth",
  "surface",
  "togglePreview",
  "unarchiveSession",
  "uninstallPlugin",
  "updateSettings",
  "usage",
  "yoloActive"
]

/** Renders the hook and hands back what it returned. */
async function captureHookResult(): Promise<Record<string, unknown>> {
  const { useGronk } = await import('../src/hooks/useGronk')
  let captured: Record<string, unknown> | null = null

  function Probe() {
    captured = useGronk() as unknown as Record<string, unknown>
    return null
  }

  const view = await mount(createElement(Probe))
  await flush()
  view.unmount()

  assert.ok(captured, 'hook returned nothing')
  return captured
}

test('the hook mounts without throwing', async () => {
  const bridge = installFakeBridge()
  try {
    const result = await captureHookResult()
    assert.equal(typeof result, 'object')
  } finally {
    bridge.restore()
  }
})

test('mounting reads the state the app needs, and does not start an agent', async () => {
  const bridge = installFakeBridge()
  try {
    await captureHookResult()

    for (const expected of ['getSettings', 'listSessions', 'getAuthStatus', 'getConnectionState']) {
      assert.ok(bridge.calls.includes(expected), `mount should call ${expected}`)
    }
    // Opening the app must never spawn the CLI or spend anything on its own.
    for (const forbidden of ['startAgent', 'sendPrompt', 'installPlugin', 'moveDataDir']) {
      assert.ok(!bridge.calls.includes(forbidden), `mount must not call ${forbidden}`)
    }
  } finally {
    bridge.restore()
  }
})

test('the public surface is exactly what is recorded', async () => {
  const bridge = installFakeBridge()
  try {
    const result = await captureHookResult()
    const actual = Object.keys(result).sort()

    const expected = [...EXPECTED_MEMBERS].sort()
    const missing = expected.filter((k) => !actual.includes(k))
    const added = actual.filter((k) => !expected.includes(k))

    assert.deepEqual(missing, [], 'members disappeared from the hook')
    assert.deepEqual(added, [], 'members appeared without being recorded')
  } finally {
    bridge.restore()
  }
})

test('every member is a value or a function, never undefined', async () => {
  const bridge = installFakeBridge()
  try {
    const result = await captureHookResult()
    // An undefined member is how a botched split shows up: the key survives, the
    // value does not, and the failure surfaces as a crash on click instead.
    const undefinedMembers = Object.entries(result)
      .filter(([, value]) => value === undefined)
      .map(([key]) => key)
    assert.deepEqual(undefinedMembers, [])
  } finally {
    bridge.restore()
  }
})
