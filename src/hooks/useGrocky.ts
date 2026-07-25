import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ActivePlan,
  AgentSurface,
  AppSettings,
  AppSurface,
  AuthStatus,
  ChatMessage,
  ConnectionState,
  HealthStatus,
  LoginMethod,
  MainToRendererEvent,
  MarketplaceSource,
  McpAddInput,
  McpServer,
  ModelInfo,
  PermissionAuditEntry,
  PermissionMode,
  PermissionRequest,
  Plugin,
  ProjectContext,
  PromptAttachment,
  SessionInfo,
  ToolCallInfo
} from '../../shared/types'
import {
  folderName,
  isChatSession,
  isChatWorkspace,
  isWorkspaceSession,
  pathsEqual
} from '../../shared/path'
import {
  createAssistantPlaceholder,
  createUserMessage,
  hasAssistantReplyAfter
} from '../lib/messages'
import { parsePlan } from '../lib/plan'
import { applyTheme } from '../lib/theme'

/** Last transcript written to disk — drives the "saved to…" banner. */
interface ExportNotice {
  path: string
  format: 'md' | 'json'
  /** Main refuses to reveal paths outside its allowed roots; show why inline */
  revealError?: string
}

export function useGrocky() {
  const [connection, setConnection] = useState<ConnectionState>('idle')
  const [cwd, setCwd] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [recentProjects, setRecentProjects] = useState<ProjectContext[]>([])
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [settings, setSettingsState] = useState<AppSettings | null>(null)
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [grokPath, setGrokPath] = useState<string | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [audit, setAudit] = useState<PermissionAuditEntry[]>([])
  const [health, setHealth] = useState<HealthStatus | null>(null)
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const [deviceHint, setDeviceHint] = useState<string | null>(null)
  const [showYoloConfirm, setShowYoloConfirm] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null)
  const [showCliInstall, setShowCliInstall] = useState(false)
  const [cliInstalling, setCliInstalling] = useState(false)
  const [cliInstallResult, setCliInstallResult] = useState<string | null>(null)
  const [previewRunning, setPreviewRunning] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  // Plugins & Skills (lazy — catalog calls hit the network / git caches)
  const [installedPlugins, setInstalledPlugins] = useState<Plugin[]>([])
  const [availablePlugins, setAvailablePlugins] = useState<Plugin[]>([])
  const [marketplaces, setMarketplaces] = useState<MarketplaceSource[]>([])
  const [mcpServers, setMcpServers] = useState<McpServer[]>([])
  const [pluginsLoading, setPluginsLoading] = useState(false)
  const [pluginsError, setPluginsError] = useState<string | null>(null)
  const [pluginBusy, setPluginBusy] = useState<string | null>(null)
  const [historySource, setHistorySource] = useState<string | null>(null)
  const [activePlan, setActivePlan] = useState<ActivePlan | null>(null)
  const [planCollapsed, setPlanCollapsed] = useState(false)
  /** home | chat | project — drives shell navigation */
  const [surface, setSurface] = useState<AppSurface>('home')
  /**
   * When true, main pane shows the browse home for that surface
   * (chat list / project tabs) instead of the live conversation.
   */
  const [browsing, setBrowsing] = useState(true)
  const [chatWorkspacePath, setChatWorkspacePath] = useState<string | null>(null)
  const [agentSurface, setAgentSurface] = useState<AgentSurface | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  const messagesRef = useRef<ChatMessage[]>([])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const refreshMeta = useCallback(async () => {
    const [projects, sess, s, path, modelList, auditList, healthStatus, authStatus, chatPath] =
      await Promise.all([
        window.grocky.getRecentProjects(),
        window.grocky.listSessions(),
        window.grocky.getSettings(),
        window.grocky.getGrokPath(),
        window.grocky.listModels(),
        window.grocky.getPermissionAudit(),
        window.grocky.getHealth(),
        window.grocky.getAuthStatus(),
        window.grocky.getChatWorkspacePath()
      ])
    setRecentProjects(projects)
    setSessions(sess)
    setSettingsState(s)
    setGrokPath(path)
    setModels(modelList)
    setAudit(auditList)
    setHealth(healthStatus)
    setAuth(authStatus)
    setChatWorkspacePath(chatPath)
    applyTheme(s.theme)
  }, [])

  useEffect(() => {
    void refreshMeta()
    void window.grocky.getConnectionState().then(setConnection)

    const unsub = window.grocky.onEvent((event: MainToRendererEvent) => {
      switch (event.type) {
        case 'connection':
          setConnection(event.state)
          if (event.error) setError(event.error)
          if (event.state === 'ready') setError(null)
          break
        case 'session':
          setSessionId(event.sessionId)
          setCwd(event.cwd)
          break
        case 'history-clear':
          setMessages([])
          setHistorySource(null)
          setActivePlan(null)
          break
        case 'history-done':
          setHistorySource(event.source)
          setBusy(false)
          void window.grocky.listSessions().then(setSessions)
          break
        case 'user-message':
          setMessages((prev) => {
            if (prev.some((m) => m.id === event.message.id)) {
              return prev.map((m) =>
                m.id === event.message.id ? { ...m, ...event.message } : m
              )
            }
            return [...prev, event.message]
          })
          break
        case 'message-chunk':
          setMessages((prev) => {
            const exists = prev.some((m) => m.id === event.messageId)
            if (!exists) {
              return [
                ...prev,
                {
                  id: event.messageId,
                  role: 'assistant' as const,
                  text: event.text,
                  createdAt: Date.now(),
                  streaming: true
                }
              ]
            }
            return prev.map((m) =>
              m.id === event.messageId ? { ...m, text: m.text + event.text } : m
            )
          })
          break
        case 'thought-chunk':
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId
                ? { ...m, thought: (m.thought || '') + event.text }
                : m
            )
          )
          break
        case 'tool-call':
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== event.messageId) return m
              const tools = [...(m.toolCalls || [])]
              const idx = tools.findIndex((t) => t.toolCallId === event.toolCall.toolCallId)
              if (idx >= 0) tools[idx] = { ...tools[idx], ...event.toolCall }
              else tools.push(event.toolCall)
              return { ...m, toolCalls: tools }
            })
          )
          break
        case 'tool-call-update':
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== event.messageId) return m
              const tools = (m.toolCalls || []).map((t) =>
                t.toolCallId === event.toolCallId ? { ...t, ...event.patch } : t
              )
              if (!tools.some((t) => t.toolCallId === event.toolCallId)) {
                tools.push({
                  toolCallId: event.toolCallId,
                  title: event.patch.title || 'Tool',
                  status: event.patch.status || 'in_progress',
                  ...event.patch
                } as ToolCallInfo)
              }
              return { ...m, toolCalls: tools }
            })
          )
          break
        case 'message-done':
          setBusy(false)
          setMessages((prev) => {
            const next = prev.map((m) =>
              m.id === event.messageId ? { ...m, streaming: false } : m
            )
            if (event.sessionId) {
              void window.grocky.saveTranscript(event.sessionId, next)
            }
            return next
          })
          void window.grocky.listSessions().then(setSessions)
          void window.grocky.getPermissionAudit().then(setAudit)
          break
        case 'permission-request':
          setPermission(event.request)
          break
        case 'plan': {
          const entries = parsePlan(event.plan)
          if (entries.length) {
            setActivePlan({
              sessionId: event.sessionId,
              messageId: event.messageId,
              entries,
              updatedAt: Date.now()
            })
            setPlanCollapsed(false)
          }
          break
        }
        case 'models':
          setModels(event.models)
          break
        case 'auth':
          setAuth(event.auth)
          if (event.auth.authenticated) setAuthMessage(null)
          break
        case 'error':
          setError(event.message)
          setBusy(false)
          break
        case 'preview-status':
          setPreviewRunning(event.running)
          setPreviewUrl(event.url)
          setPreviewError(event.error || null)
          break
        case 'preview-log':
          break
        default:
          break
      }
    })

    return unsub
  }, [refreshMeta])

  // Theme: system preference changes
  useEffect(() => {
    if (!settings || settings.theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const handler = () => applyTheme('system')
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [settings?.theme])

  // Smart scroll: only stick when near bottom
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight
      stickToBottom.current = dist < 80
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, permission, activePlan])

  // Persist transcript while chatting
  useEffect(() => {
    if (!sessionId || messages.length === 0) return
    const t = setTimeout(() => {
      void window.grocky.saveTranscript(sessionId, messagesRef.current)
    }, 400)
    return () => clearTimeout(t)
  }, [messages, sessionId])

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'n' && cwd) {
        e.preventDefault()
        void openProjectRef.current?.(cwd, { forceNew: true })
      }
      if (mod && e.key === ',') {
        e.preventDefault()
        setShowSettings(true)
      }
      if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        void openProjectRef.current?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cwd])

  const openProject = useCallback(
    async (folder?: string | null, opts?: { forceNew?: boolean }) => {
      setError(null)

      const authNow = await window.grocky.getAuthStatus()
      setAuth(authNow)
      if (!authNow.authenticated) {
        setError(
          authNow.message ||
            'Sign in with your own Grok account before opening a project.'
        )
        return
      }

      let target = folder
      if (!target) {
        target = await window.grocky.selectFolder()
      }
      if (!target) return

      const sameProject =
        cwd &&
        pathsEqual(cwd, target) &&
        connection === 'ready' &&
        agentSurface === 'project'

      if (sameProject && !opts?.forceNew) {
        setSurface('project')
        setBrowsing(false)
        await refreshMeta()
        return
      }

      setMessages([])
      setSessionId(null)
      setCwd(target)
      setBusy(false)
      setPermission(null)
      setHistorySource(null)
      setActivePlan(null)
      setSurface('project')
      setBrowsing(false)
      setAgentSurface('project')

      try {
        const s = await window.grocky.getSettings()
        const { sessionId: id } = await window.grocky.startAgent(target, {
          model: s.model,
          alwaysApprove: s.alwaysApprove,
          forceNew: opts?.forceNew,
          surface: 'project'
        })
        setSessionId(id)
        await refreshMeta()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [cwd, connection, refreshMeta, agentSurface]
  )

  const openProjectRef = useRef(openProject)
  openProjectRef.current = openProject

  /** General Grok chat (website/X-style) via CLI — not a coding project */
  const openChat = useCallback(
    async (opts?: { forceNew?: boolean }) => {
      setError(null)
      const authNow = await window.grocky.getAuthStatus()
      setAuth(authNow)
      if (!authNow.authenticated) {
        setError(
          authNow.message ||
            'Sign in with your own Grok account before chatting.'
        )
        return
      }

      const chatPath =
        chatWorkspacePath || (await window.grocky.getChatWorkspacePath())
      setChatWorkspacePath(chatPath)

      const sameChat =
        cwd &&
        isChatWorkspace(cwd, chatPath) &&
        connection === 'ready' &&
        agentSurface === 'chat'

      if (sameChat && !opts?.forceNew) {
        setSurface('chat')
        setBrowsing(false)
        await refreshMeta()
        return
      }

      setMessages([])
      setSessionId(null)
      setCwd(chatPath)
      setBusy(false)
      setPermission(null)
      setHistorySource(null)
      setActivePlan(null)
      setSurface('chat')
      setBrowsing(false)
      setAgentSurface('chat')

      try {
        const s = await window.grocky.getSettings()
        const { sessionId: id } = await window.grocky.startAgent(chatPath, {
          model: s.model,
          alwaysApprove: s.alwaysApprove,
          forceNew: opts?.forceNew,
          surface: 'chat'
        })
        setSessionId(id)
        await refreshMeta()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [chatWorkspacePath, cwd, connection, refreshMeta, agentSurface]
  )

  const newChat = useCallback(async () => {
    if (agentSurface === 'chat' || surface === 'chat') {
      await openChat({ forceNew: true })
      return
    }
    if (!cwd) return
    await openProject(cwd, { forceNew: true })
  }, [cwd, openProject, openChat, agentSurface, surface])

  const goHome = useCallback(() => {
    setSurface('home')
    setBrowsing(true)
  }, [])

  /** Chat browse home — previous chats (does not start a new agent) */
  const goChat = useCallback(() => {
    setSurface('chat')
    setBrowsing(true)
  }, [])

  /** Projects browse home — tabbed projects / sessions (no Explorer) */
  const goProjects = useCallback(() => {
    setSurface('project')
    setBrowsing(true)
  }, [])

  const selectSession = useCallback(
    async (session: SessionInfo) => {
      setError(null)
      const authNow = await window.grocky.getAuthStatus()
      setAuth(authNow)
      if (!authNow.authenticated) {
        setError(
          authNow.message ||
            'Sign in with your own Grok account before restoring a session.'
        )
        return
      }

      const chatPath =
        chatWorkspacePath || (await window.grocky.getChatWorkspacePath())
      const isChat = isChatWorkspace(session.cwd, chatPath)

      setPermission(null)
      setBusy(true)
      setHistorySource(null)
      setActivePlan(null)
      setSessionId(session.id)
      setCwd(session.cwd)
      setSurface(isChat ? 'chat' : 'project')
      setBrowsing(false)
      setAgentSurface(isChat ? 'chat' : 'project')
      stickToBottom.current = true

      try {
        const local = await window.grocky.getTranscript(session.id)
        if (local.length) {
          setMessages(
            local.map((m) => ({
              ...m,
              streaming: false,
              sendStatus:
                m.role === 'user'
                  ? m.sendStatus === 'failed'
                    ? ('failed' as const)
                    : ('sent' as const)
                  : m.sendStatus
            }))
          )
        } else setMessages([])

        const result = await window.grocky.loadSession(session.id)
        setSessionId(result.sessionId)
        await refreshMeta()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      }
    },
    [refreshMeta, chatWorkspacePath]
  )

  const sendPrompt = useCallback(
    async (
      text: string,
      attachments: PromptAttachment[] = [],
      opts?: { replaceUserId?: string }
    ) => {
      const trimmed = text.trim()
      if ((!trimmed && attachments.length === 0) || busy || connection !== 'ready') return

      setError(null)
      setBusy(true)
      stickToBottom.current = true

      let userId = opts?.replaceUserId
      if (userId) {
        // Retry: reuse the same bubble — never spam a second copy
        setMessages((prev) =>
          prev.map((m) =>
            m.id === userId
              ? {
                  ...m,
                  text: trimmed,
                  attachments: attachments.length ? attachments : m.attachments,
                  sendStatus: 'sending' as const,
                  error: undefined
                }
              : m
          )
        )
      } else {
        const msg = createUserMessage(trimmed, attachments, 'sending')
        userId = msg.id
        setMessages((prev) => [...prev, msg])
      }

      try {
        const { messageId } = await window.grocky.sendPrompt(trimmed, { attachments })
        setMessages((prev) => {
          const next = prev.map((m) =>
            m.id === userId ? { ...m, sendStatus: 'sent' as const, error: undefined } : m
          )
          // Drop empty failed placeholders that might sit after a retried user msg
          const cleaned = next.filter(
            (m, i) =>
              !(
                m.role === 'assistant' &&
                !m.text &&
                !m.streaming &&
                !m.toolCalls?.length &&
                i > 0 &&
                next[i - 1]?.id === userId
              )
          )
          return [...cleaned, createAssistantPlaceholder(messageId)]
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setBusy(false)
        setError(message)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === userId
              ? { ...m, sendStatus: 'failed' as const, error: message }
              : m
          )
        )
      }
    },
    [busy, connection]
  )

  /** Retry only a failed / unanswered user message without duplicating it. */
  const retryPrompt = useCallback(
    async (userMessageId: string) => {
      if (busy || connection !== 'ready') return
      const list = messagesRef.current
      const idx = list.findIndex((m) => m.id === userMessageId && m.role === 'user')
      if (idx < 0) return
      const msg = list[idx]
      if (hasAssistantReplyAfter(list, idx) && msg.sendStatus !== 'failed') {
        // Already answered — do not re-send / spam
        return
      }
      // Drop empty/incomplete assistant placeholders after this user turn only
      setMessages((prev) => {
        const cut = prev.findIndex((m) => m.id === userMessageId)
        if (cut < 0) return prev
        const head = prev.slice(0, cut + 1)
        let i = cut + 1
        while (i < prev.length && prev[i].role === 'assistant') {
          const a = prev[i]
          const empty = !a.text && !a.toolCalls?.length && !a.thought
          if (empty || a.streaming) {
            i++
            continue
          }
          break
        }
        return [...head, ...prev.slice(i)]
      })
      await sendPrompt(msg.text, msg.attachments || [], { replaceUserId: userMessageId })
    },
    [busy, connection, sendPrompt]
  )

  const cancel = useCallback(async () => {
    await window.grocky.cancelPrompt()
    setBusy(false)
  }, [])

  const respondPermission = useCallback(
    async (decision: 'allow-once' | 'allow-always' | 'reject-once') => {
      if (!permission) return
      await window.grocky.respondPermission(permission.requestId, decision)
      setPermission(null)
      void window.grocky.getPermissionAudit().then(setAudit)
    },
    [permission]
  )

  const updateSettings = useCallback(async (partial: Partial<AppSettings>) => {
    // FIX-14: re-confirm YOLO every enable (not only first install)
    if (
      partial.alwaysApprove === true ||
      partial.permissionMode === 'bypassPermissions'
    ) {
      setShowYoloConfirm(true)
      return await window.grocky.getSettings()
    }
    const next = await window.grocky.setSettings(partial)
    setSettingsState(next)
    if (partial.theme) applyTheme(next.theme)
    if (partial.grokBinary !== undefined) {
      const path = await window.grocky.getGrokPath()
      setGrokPath(path)
      const h = await window.grocky.getHealth()
      setHealth(h)
    }
    return next
  }, [])

  const confirmYolo = useCallback(async () => {
    // Two-step so store guard sees priorAck (FIX-14)
    await window.grocky.setSettings({ alwaysApproveAck: true })
    const next = await window.grocky.setSettings({
      alwaysApprove: true,
      permissionMode: 'bypassPermissions'
    })
    setSettingsState(next)
    setShowYoloConfirm(false)
    if (cwd && connection === 'ready') {
      if (agentSurface === 'chat') await openChat({ forceNew: true })
      else await openProject(cwd, { forceNew: true })
    }
  }, [cwd, connection, openProject, openChat, agentSurface])

  const changePermissionMode = useCallback(
    async (mode: PermissionMode) => {
      if (mode === 'bypassPermissions') {
        setShowYoloConfirm(true)
        return
      }
      const next = await window.grocky.setSettings({
        permissionMode: mode,
        alwaysApprove: false
      })
      setSettingsState(next)
      // Restart agent so CLI gets the new mode
      if (cwd && (connection === 'ready' || connection === 'error')) {
        if (agentSurface === 'chat') await openChat({ forceNew: true })
        else await openProject(cwd, { forceNew: true })
      }
    },
    [cwd, connection, openProject, openChat, agentSurface]
  )

  const cancelYolo = useCallback(() => {
    setShowYoloConfirm(false)
  }, [])

  const changeModel = useCallback(
    async (modelId: string) => {
      const next = await window.grocky.setSettings({ model: modelId })
      setSettingsState(next)
      if (cwd) {
        if (agentSurface === 'chat') await openChat({ forceNew: true })
        else await openProject(cwd, { forceNew: true })
      }
    },
    [cwd, openProject, openChat, agentSurface]
  )

  const renameSession = useCallback(async (id: string, title: string) => {
    await window.grocky.renameSession(id, title)
    const sess = await window.grocky.listSessions()
    setSessions(sess)
  }, [])

  const deleteSession = useCallback(
    async (id: string) => {
      const sess = await window.grocky.deleteSession(id)
      setSessions(sess)
      if (sessionId === id) {
        setMessages([])
        setSessionId(null)
        setActivePlan(null)
        setHistorySource(null)
        if (agentSurface === 'chat') await openChat({ forceNew: true })
        else if (cwd) await openProject(cwd, { forceNew: true })
      }
    },
    [sessionId, cwd, openProject, openChat, agentSurface]
  )

  const archiveSession = useCallback(
    async (id: string) => {
      await window.grocky.archiveSession(id, true)
      const sess = await window.grocky.listSessions()
      setSessions(sess)
      if (sessionId === id) {
        setMessages([])
        setSessionId(null)
        setActivePlan(null)
        setHistorySource(null)
        if (agentSurface === 'chat') await openChat({ forceNew: true })
        else if (cwd) await openProject(cwd, { forceNew: true })
      }
    },
    [sessionId, cwd, openProject, openChat, agentSurface]
  )

  /** Put an archived session back into the normal lists. */
  const unarchiveSession = useCallback(async (id: string) => {
    await window.grocky.archiveSession(id, false)
    const sess = await window.grocky.listSessions()
    setSessions(sess)
  }, [])

  const exportSession = useCallback(async (id: string, format: 'md' | 'json' = 'md') => {
    try {
      const result = await window.grocky.exportTranscript(id, format)
      // null = save dialog cancelled (or nothing to export) — stay silent
      if (!result?.path) return
      setExportNotice({ path: result.path, format })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const revealExport = useCallback(async () => {
    if (!exportNotice) return
    const res = await window.grocky.revealLocalPath(exportNotice.path)
    // Keep the notice up either way — the path itself is the answer to "where?"
    setExportNotice((prev) =>
      prev
        ? {
            ...prev,
            revealError: res.ok ? undefined : res.error || 'Could not open the folder'
          }
        : prev
    )
  }, [exportNotice])

  const dismissExport = useCallback(() => setExportNotice(null), [])

  const pickBinary = useCallback(async () => {
    const path = await window.grocky.selectFile({
      title: 'Select grok binary',
      filters:
        window.grocky.platform === 'win32'
          ? [{ name: 'Executable', extensions: ['exe'] }]
          : undefined
    })
    if (path) await updateSettings({ grokBinary: path })
  }, [updateSettings])

  const clearBinary = useCallback(async () => {
    // Empty string clears override (Electron IPC drops `undefined` keys)
    const next = await window.grocky.setSettings({ grokBinary: '' })
    setSettingsState(next)
    const path = await window.grocky.getGrokPath()
    setGrokPath(path)
    setHealth(await window.grocky.getHealth())
  }, [])

  const refreshHealth = useCallback(async () => {
    const h = await window.grocky.getHealth()
    setHealth(h)
    setGrokPath(h.grokPath)
    setAuth(h.auth)
  }, [])

  const installCli = useCallback(async () => {
    setCliInstalling(true)
    setCliInstallResult(null)
    try {
      const res = await window.grocky.installCli()
      setCliInstallResult(res.message)
      await refreshMeta()
      return res
    } catch (err) {
      setCliInstallResult(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setCliInstalling(false)
    }
  }, [refreshMeta])

  const startPreview = useCallback(async () => {
    if (!cwd) return
    setPreviewError(null)
    const s = await window.grocky.getSettings()
    const res = await window.grocky.previewStart(cwd, s.previewCommand)
    if (!res.ok) setPreviewError(res.message)
  }, [cwd])

  const stopPreview = useCallback(async () => {
    await window.grocky.previewStop()
  }, [])

  const togglePreview = useCallback(() => {
    if (previewRunning) void stopPreview()
    else void startPreview()
  }, [previewRunning, startPreview, stopPreview])

  // ── Plugins & Skills ──────────────────────────────────────────────
  const refreshPlugins = useCallback(async () => {
    setPluginsLoading(true)
    setPluginsError(null)
    try {
      const [inst, mkts, servers] = await Promise.all([
        window.grocky.listInstalledPlugins(),
        window.grocky.listMarketplaces(),
        window.grocky.listMcpServers()
      ])
      setInstalledPlugins(inst)
      setMarketplaces(mkts)
      setMcpServers(servers)
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
      setAvailablePlugins(await window.grocky.listAvailablePlugins())
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
        if (!res.ok) setPluginsError(res.message)
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
      runPluginAction(source, () => window.grocky.installPlugin(source, trust)),
    [runPluginAction]
  )
  const enablePlugin = useCallback(
    (name: string) => runPluginAction(name, () => window.grocky.enablePlugin(name)),
    [runPluginAction]
  )
  const disablePlugin = useCallback(
    (name: string) => runPluginAction(name, () => window.grocky.disablePlugin(name)),
    [runPluginAction]
  )
  const uninstallPlugin = useCallback(
    (name: string) => runPluginAction(name, () => window.grocky.uninstallPlugin(name)),
    [runPluginAction]
  )

  const addMcpServer = useCallback(
    async (input: McpAddInput) => {
      setPluginBusy(input.name)
      setPluginsError(null)
      try {
        const res = await window.grocky.addMcpServer(input)
        if (!res.ok) setPluginsError(res.message)
        if (res.servers) setMcpServers(res.servers)
        else setMcpServers(await window.grocky.listMcpServers())
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
      const res = await window.grocky.removeMcpServer(name)
      if (!res.ok) setPluginsError(res.message)
      if (res.servers) setMcpServers(res.servers)
      else setMcpServers(await window.grocky.listMcpServers())
    } catch (err) {
      setPluginsError(err instanceof Error ? err.message : String(err))
    } finally {
      setPluginBusy(null)
    }
  }, [])

  const refreshAuth = useCallback(async () => {
    setAuthBusy(true)
    try {
      const a = await window.grocky.getAuthStatus()
      setAuth(a)
      setAuthMessage(a.message || null)
    } finally {
      setAuthBusy(false)
    }
  }, [])

  const login = useCallback(async (method: LoginMethod = 'oauth') => {
    setAuthBusy(true)
    setAuthMessage(
      method === 'device'
        ? 'Device login started — complete the code in your browser…'
        : 'Browser login started — complete sign-in in the window that opens…'
    )
    setDeviceHint(null)
    try {
      const result = await window.grocky.login(method)
      setAuth(result.auth)
      setAuthMessage(result.message)
      if (result.deviceHint) setDeviceHint(result.deviceHint)
      if (result.ok) {
        await refreshMeta()
      }
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setAuthMessage(msg)
      return null
    } finally {
      setAuthBusy(false)
    }
  }, [refreshMeta])

  const logout = useCallback(async () => {
    setAuthBusy(true)
    setDeviceHint(null)
    try {
      // Clear live session UI immediately
      setMessages([])
      setSessionId(null)
      setCwd(null)
      setActivePlan(null)
      setPermission(null)
      setBusy(false)
      setConnection('idle')

      const result = await window.grocky.logout()
      setAuth(result.auth)
      setAuthMessage(result.message)
      await refreshMeta()
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setAuthMessage(msg)
      return null
    } finally {
      setAuthBusy(false)
    }
  }, [refreshMeta])

  const projectName = useMemo(() => {
    if (!cwd) return null
    if (agentSurface === 'chat') return 'Chat'
    return folderName(cwd)
  }, [cwd, agentSurface])

  const uniqueSessions = useMemo(() => {
    const seen = new Set<string>()
    const out: SessionInfo[] = []
    for (const s of sessions) {
      if (!s.id || seen.has(s.id)) continue
      seen.add(s.id)
      out.push(s)
    }
    return out
  }, [sessions])

  const activeSessions = useMemo(
    () => uniqueSessions.filter((s) => !s.archived),
    [uniqueSessions]
  )

  /** Hidden from every normal list — only the Archived panel reads this. */
  const archivedSessions = useMemo(
    () =>
      uniqueSessions
        .filter((s) => s.archived)
        .sort((a, b) => (b.archivedAt || b.updatedAt) - (a.archivedAt || a.updatedAt)),
    [uniqueSessions]
  )

  const chatSessions = useMemo(
    () => activeSessions.filter((s) => isChatSession(s, chatWorkspacePath)),
    [activeSessions, chatWorkspacePath]
  )

  /**
   * Workspace (folder) sessions only.
   * App Chat is stored under userData/chat-workspace and never listed here.
   */
  const projectOnlySessions = useMemo(
    () => activeSessions.filter((s) => isWorkspaceSession(s, chatWorkspacePath)),
    [activeSessions, chatWorkspacePath]
  )

  /** Workspace folders only — strip chat sandbox if it ever landed in recent */
  const workspaceProjects = useMemo(
    () => recentProjects.filter((p) => !isChatWorkspace(p.cwd, chatWorkspacePath)),
    [recentProjects, chatWorkspacePath]
  )

  const yoloActive = !!(
    (settings?.alwaysApprove && settings?.alwaysApproveAck) ||
    (settings?.permissionMode === 'bypassPermissions' && settings?.alwaysApproveAck)
  )
  const permissionMode: PermissionMode =
    settings?.permissionMode || (yoloActive ? 'bypassPermissions' : 'default')
  const isAuthenticated = !!auth?.authenticated

  return {
    connection,
    cwd,
    projectName,
    sessionId,
    messages,
    recentProjects: workspaceProjects,
    sessions: uniqueSessions,
    chatSessions,
    /** Folder agent sessions only (never app Chat) */
    projectOnlySessions,
    archivedSessions,
    surface,
    browsing,
    agentSurface,
    chatWorkspacePath,
    openChat,
    goHome,
    goChat,
    goProjects,
    settings,
    permission,
    error,
    busy,
    grokPath,
    models,
    audit,
    health,
    auth,
    authBusy,
    authMessage,
    deviceHint,
    isAuthenticated,
    showYoloConfirm,
    showSettings,
    setShowSettings,
    showArchived,
    setShowArchived,
    exportNotice,
    revealExport,
    dismissExport,
    showCliInstall,
    setShowCliInstall,
    cliInstalling,
    cliInstallResult,
    setCliInstallResult,
    installCli,
    previewRunning,
    previewUrl,
    previewError,
    startPreview,
    stopPreview,
    togglePreview,
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
    removeMcpServer,
    historySource,
    activePlan,
    planCollapsed,
    setPlanCollapsed,
    yoloActive,
    permissionMode,
    scrollRef,
    openProject,
    newChat,
    selectSession,
    sendPrompt,
    retryPrompt,
    cancel,
    respondPermission,
    updateSettings,
    confirmYolo,
    cancelYolo,
    changeModel,
    changePermissionMode,
    renameSession,
    deleteSession,
    archiveSession,
    unarchiveSession,
    exportSession,
    pickBinary,
    clearBinary,
    refreshHealth,
    refreshAuth,
    login,
    logout,
    setError,
    refreshMeta
  }
}
