import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettings,
  ChatMessage,
  ConnectionState,
  MainToRendererEvent,
  ModelInfo,
  PermissionAuditEntry,
  PermissionRequest,
  ProjectContext,
  SessionInfo,
  ToolCallInfo
} from '../../shared/types'

function createUserMessage(text: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    text,
    createdAt: Date.now()
  }
}

function createAssistantPlaceholder(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    text: '',
    thought: '',
    toolCalls: [],
    createdAt: Date.now(),
    streaming: true
  }
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
  const [showYoloConfirm, setShowYoloConfirm] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [historySource, setHistorySource] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const messagesRef = useRef<ChatMessage[]>([])

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const refreshMeta = useCallback(async () => {
    const [projects, sess, s, path, modelList, auditList] = await Promise.all([
      window.grocky.getRecentProjects(),
      window.grocky.listSessions(),
      window.grocky.getSettings(),
      window.grocky.getGrokPath(),
      window.grocky.listModels(),
      window.grocky.getPermissionAudit()
    ])
    setRecentProjects(projects)
    setSessions(sess)
    setSettingsState(s)
    setGrokPath(path)
    setModels(modelList)
    setAudit(auditList)
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
        case 'models':
          setModels(event.models)
          break
        case 'error':
          setError(event.message)
          setBusy(false)
          break
        default:
          break
      }
    })

    return unsub
  }, [refreshMeta])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [messages, permission])

  // Persist transcript while chatting
  useEffect(() => {
    if (!sessionId || messages.length === 0) return
    const t = setTimeout(() => {
      void window.grocky.saveTranscript(sessionId, messagesRef.current)
    }, 400)
    return () => clearTimeout(t)
  }, [messages, sessionId])

  const normalizePath = useCallback((p: string) => {
    return p.replace(/\\/g, '/').replace(/\/+$/, '')
  }, [])

  const openProject = useCallback(
    async (folder?: string | null, opts?: { forceNew?: boolean }) => {
      setError(null)
      let target = folder
      if (!target) {
        target = await window.grocky.selectFolder()
      }
      if (!target) return

      const sameProject =
        cwd && normalizePath(cwd) === normalizePath(target) && connection === 'ready'

      if (sameProject && !opts?.forceNew) {
        await refreshMeta()
        return
      }

      setMessages([])
      setSessionId(null)
      setCwd(target)
      setBusy(false)
      setPermission(null)
      setHistorySource(null)

      try {
        const s = await window.grocky.getSettings()
        const { sessionId: id } = await window.grocky.startAgent(target, {
          model: s.model,
          alwaysApprove: s.alwaysApprove,
          forceNew: opts?.forceNew
        })
        setSessionId(id)
        await refreshMeta()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [cwd, connection, normalizePath, refreshMeta]
  )

  const newChat = useCallback(async () => {
    if (!cwd) return
    await openProject(cwd, { forceNew: true })
  }, [cwd, openProject])

  const selectSession = useCallback(
    async (session: SessionInfo) => {
      setError(null)
      setPermission(null)
      setBusy(true)
      setHistorySource(null)
      setSessionId(session.id)
      setCwd(session.cwd)

      try {
        // Local transcript first for instant UI
        const local = await window.grocky.getTranscript(session.id)
        if (local.length) setMessages(local.map((m) => ({ ...m, streaming: false })))
        else setMessages([])

        const result = await window.grocky.loadSession(session.id)
        setSessionId(result.sessionId)
        await refreshMeta()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      }
    },
    [refreshMeta]
  )

  const sendPrompt = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || busy || connection !== 'ready') return

      setError(null)
      setBusy(true)
      setMessages((prev) => [...prev, createUserMessage(trimmed)])

      try {
        const { messageId } = await window.grocky.sendPrompt(trimmed)
        setMessages((prev) => [...prev, createAssistantPlaceholder(messageId)])
      } catch (err) {
        setBusy(false)
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [busy, connection]
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
    // Intercept YOLO enable → require confirm
    if (partial.alwaysApprove === true) {
      const current = await window.grocky.getSettings()
      if (!current.alwaysApproveAck) {
        setShowYoloConfirm(true)
        return current
      }
    }
    const next = await window.grocky.setSettings(partial)
    setSettingsState(next)
    return next
  }, [])

  const confirmYolo = useCallback(async () => {
    const next = await window.grocky.setSettings({
      alwaysApproveAck: true,
      alwaysApprove: true
    })
    setSettingsState(next)
    setShowYoloConfirm(false)
    // Restart agent with flag if a project is open
    if (cwd && connection === 'ready') {
      await openProject(cwd, { forceNew: true })
    }
  }, [cwd, connection, openProject])

  const cancelYolo = useCallback(() => {
    setShowYoloConfirm(false)
  }, [])

  const changeModel = useCallback(
    async (modelId: string) => {
      const next = await window.grocky.setSettings({ model: modelId })
      setSettingsState(next)
      if (cwd) {
        await openProject(cwd, { forceNew: true })
      }
    },
    [cwd, openProject]
  )

  const projectName = useMemo(() => {
    if (!cwd) return null
    const parts = cwd.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || cwd
  }, [cwd])

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

  const yoloActive = !!(settings?.alwaysApprove && settings?.alwaysApproveAck)

  return {
    connection,
    cwd,
    projectName,
    sessionId,
    messages,
    recentProjects,
    sessions: uniqueSessions,
    settings,
    permission,
    error,
    busy,
    grokPath,
    models,
    audit,
    showYoloConfirm,
    showSettings,
    setShowSettings,
    historySource,
    yoloActive,
    scrollRef,
    openProject,
    newChat,
    selectSession,
    sendPrompt,
    cancel,
    respondPermission,
    updateSettings,
    confirmYolo,
    cancelYolo,
    changeModel,
    setError,
    refreshMeta
  }
}
