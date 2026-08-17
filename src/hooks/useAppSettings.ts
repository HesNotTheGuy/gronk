import { useCallback, useEffect, useState } from 'react'
import type {
  AppSettings,
  AuthStatus,
  ConnectionState,
  HealthStatus,
  MainToRendererEvent,
  ModelInfo,
  PermissionAuditEntry,
  PermissionMode
} from '../../shared/types'
import { applyTheme } from '../lib/theme'

interface SettingsDeps {
  cwd: string | null
  connection: ConnectionState
  /**
   * Restart the agent on whichever surface is live, forcing a new session. The
   * CLI reads its permission mode at spawn time, so changing that only reaches it
   * through a fresh agent.
   */
  restartAgent: () => Promise<void>
  /**
   * Switch the running session's model in place. Resolves `false` when there is no
   * live session to switch, which is not a failure — it means the choice applies to
   * the next one and only has to be stored.
   */
  liveSwitchModel: (modelId: string) => Promise<boolean>
  /** useAuth's setter: a health refresh returns an AuthStatus with it. */
  setAuth: (auth: AuthStatus) => void
}

/**
 * Stored settings and everything derived from them: the model list, the grok
 * binary, the health probe, the permission audit and the YOLO acknowledgement
 * gate.
 *
 * Subscribes to `onEvent` itself for `models`: main pushes the list once the
 * CLI reports what it actually supports, and nothing else consumes that event.
 * The subscription is returned from the effect so it is torn down on unmount;
 * leaking it would make every later model push land twice.
 */
export function useAppSettings({
  cwd,
  connection,
  restartAgent,
  liveSwitchModel,
  setAuth
}: SettingsDeps) {
  const [settings, setSettingsState] = useState<AppSettings | null>(null)
  const [grokPath, setGrokPath] = useState<string | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [audit, setAudit] = useState<PermissionAuditEntry[]>([])
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [showYoloConfirm, setShowYoloConfirm] = useState(false)

  useEffect(() => {
    return window.gronk.onEvent((event: MainToRendererEvent) => {
      if (event.type !== 'models') return
      setModels(event.models)
    })
  }, [])

  // Theme: system preference changes
  useEffect(() => {
    if (!settings || settings.theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = () => applyTheme('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [settings?.theme])

  /**
   * Write-through for the composer's `refreshMeta`, which reads all of this in
   * one `Promise.all`. One entry point rather than five exported setters, so the
   * theme side effect stays with the state that causes it.
   */
  const hydrate = useCallback(
    (meta: {
      settings: AppSettings
      grokPath: string | null
      models: ModelInfo[]
      audit: PermissionAuditEntry[]
      health: HealthStatus
    }) => {
      setSettingsState(meta.settings)
      setGrokPath(meta.grokPath)
      setModels(meta.models)
      setAudit(meta.audit)
      setHealth(meta.health)
      applyTheme(meta.settings.theme)
    },
    []
  )

  /** Re-read the permission audit after anything that could have appended to it. */
  const refreshAudit = useCallback(async () => {
    setAudit(await window.gronk.getPermissionAudit())
  }, [])

  const updateSettings = useCallback(async (partial: Partial<AppSettings>) => {
    // Re-confirm YOLO every enable (not only first install).
    if (
      partial.alwaysApprove === true ||
      partial.permissionMode === 'bypassPermissions'
    ) {
      setShowYoloConfirm(true)
      return await window.gronk.getSettings()
    }
    const next = await window.gronk.setSettings(partial)
    setSettingsState(next)
    if (partial.theme) applyTheme(next.theme)
    if (partial.grokBinary !== undefined) {
      const path = await window.gronk.getGrokPath()
      setGrokPath(path)
      const h = await window.gronk.getHealth()
      setHealth(h)
    }
    return next
  }, [])

  const confirmYolo = useCallback(async () => {
    // Two-step so the store guard sees priorAck before enable.
    await window.gronk.setSettings({ alwaysApproveAck: true })
    const next = await window.gronk.setSettings({
      alwaysApprove: true,
      permissionMode: 'bypassPermissions'
    })
    setSettingsState(next)
    setShowYoloConfirm(false)
    if (cwd && connection === 'ready') await restartAgent()
  }, [cwd, connection, restartAgent])

  const changePermissionMode = useCallback(
    async (mode: PermissionMode, runningMode?: PermissionMode | null) => {
      // Same as the model: choosing the mode already in force restarts nothing.
      if (mode === (runningMode ?? settings?.permissionMode)) return
      if (mode === 'bypassPermissions') {
        setShowYoloConfirm(true)
        return
      }
      const next = await window.gronk.setSettings({
        permissionMode: mode,
        alwaysApprove: false
      })
      setSettingsState(next)
      // Restart agent so CLI gets the new mode
      if (cwd && (connection === 'ready' || connection === 'error')) await restartAgent()
    },
    [cwd, connection, restartAgent, settings?.permissionMode]
  )

  const cancelYolo = useCallback(() => {
    setShowYoloConfirm(false)
  }, [])

  /**
   * Switch the model of the conversation in front of you. This session only.
   *
   * It used to write the stored default as well, and that is how an install ends up
   * pinned: one switch inside one chat, months ago, and every session since has been
   * started with `-m` naming a model the CLI has long stopped defaulting to. Nobody
   * chose that, and nothing in the app said it had happened.
   *
   * So the two questions are two controls now. This one is "what is this conversation
   * running", and the Settings dropdown is "what should new ones start with" — which is
   * also the only place a pin can be created, deliberately, and seen afterwards.
   */
  const changeModel = useCallback(
    async (modelId: string, runningModel?: string | null) => {
      // Picking the model already in use does nothing at all. It used to write the
      // setting and restart, and restarting means `forceNew` — so choosing the model you
      // were already on replaced the conversation with an empty session. Nothing about
      // that was asked for.
      if (modelId === (runningModel ?? settings?.model)) return
      await liveSwitchModel(modelId)
    },
    [liveSwitchModel, settings?.model]
  )

  /**
   * The model new sessions start with. `''` clears it, which is the shipped state.
   *
   * Cleared means Gronk passes no `-m` at all and the CLI uses its own default, so a
   * newer model arrives on its own. A stored value overrides that until it is cleared
   * again — which is the entire point of storing one, and was the entire problem when
   * there was no way to.
   *
   * Deliberately does not touch a running session: this is a statement about the next
   * one, and reaching into the current conversation to apply it would be answering a
   * question nobody asked.
   */
  const setDefaultModel = useCallback(async (modelId: string) => {
    const next = await window.gronk.setSettings({ model: modelId })
    setSettingsState(next)
  }, [])

  /**
   * How hard the model thinks, for sessions started from now on. `''` clears it.
   *
   * New-sessions-only is not a simplification, it is the mechanism: the level is the
   * value of `--reasoning-effort`, which grok reads once when the child is spawned.
   * There is no way to change it on a running session — `session/set_config_option`
   * exists in the protocol and answers -32601 for this build — so applying it to the
   * conversation in front of you would mean silently restarting it, and a restart is a
   * new session with an empty transcript.
   */
  const setDefaultReasoningEffort = useCallback(async (effort: string) => {
    const next = await window.gronk.setSettings({
      reasoningEffort: effort as AppSettings['reasoningEffort']
    })
    setSettingsState(next)
  }, [])

  /**
   * Record that this version's notes have been read.
   *
   * One field, in the settings store rather than the transcript store — it is about the
   * install, not a conversation, and it has to survive an update or the panel comes back on
   * every release.
   */
  const markNotesSeen = useCallback(async (version: string) => {
    if (!version) return
    const next = await window.gronk.setSettings({ seenNotesVersion: version })
    setSettingsState(next)
  }, [])

  const pickBinary = useCallback(async () => {
    const path = await window.gronk.selectFile({
      title: 'Select grok binary',
      filters:
        window.gronk.platform === 'win32'
          ? [{ name: 'Executable', extensions: ['exe'] }]
          : undefined
    })
    if (path) await updateSettings({ grokBinary: path })
  }, [updateSettings])

  const clearBinary = useCallback(async () => {
    // Empty string clears override (Electron IPC drops `undefined` keys)
    const next = await window.gronk.setSettings({ grokBinary: '' })
    setSettingsState(next)
    const path = await window.gronk.getGrokPath()
    setGrokPath(path)
    setHealth(await window.gronk.getHealth())
  }, [])

  const refreshHealth = useCallback(async () => {
    const h = await window.gronk.getHealth()
    setHealth(h)
    setGrokPath(h.grokPath)
    setAuth(h.auth)
  }, [setAuth])

  const yoloActive = !!(
    (settings?.alwaysApprove && settings?.alwaysApproveAck) ||
    (settings?.permissionMode === 'bypassPermissions' && settings?.alwaysApproveAck)
  )
  const permissionMode: PermissionMode =
    settings?.permissionMode || (yoloActive ? 'bypassPermissions' : 'default')

  return {
    settings,
    grokPath,
    models,
    audit,
    health,
    showYoloConfirm,
    yoloActive,
    permissionMode,
    updateSettings,
    confirmYolo,
    cancelYolo,
    changeModel,
    setDefaultModel,
    setDefaultReasoningEffort,
    markNotesSeen,
    changePermissionMode,
    pickBinary,
    clearBinary,
    refreshHealth,
    // For the composer only. Not part of the app's public surface.
    hydrate,
    refreshAudit
  }
}
