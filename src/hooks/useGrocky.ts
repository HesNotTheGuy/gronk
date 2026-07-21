import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppSettings,
  ChatMessage,
  ConnectionState,
  MainToRendererEvent,
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
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const refreshMeta = useCallback(async () => {
    const [projects, sess, s, path] = await Promise.all([
      window.grocky.getRecentProjects(),
      window.grocky.listSessions(),
      window.grocky.getSettings(),
      window.grocky.getGrokPath()
    ])
    setRecentProjects(projects)
    setSessions(sess)
    setSettingsState(s)
    setGrokPath(path)
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
        case 'message-chunk':
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId ? { ...m, text: m.text + event.text } : m
            )
          )
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
              // If update arrives before tool_call
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
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId ? { ...m, streaming: false } : m
            )
          )
          void window.grocky.listSessions().then(setSessions)
          break
        case 'permission-request':
          setPermission(event.request)
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

  const openProject = useCallback(async (folder?: string | null) => {
    setError(null)
    let target = folder
    if (!target) {
      target = await window.grocky.selectFolder()
    }
    if (!target) return

    setMessages([])
    setSessionId(null)
    setCwd(target)
    setBusy(false)

    try {
      const settings = await window.grocky.getSettings()
      const { sessionId: id } = await window.grocky.startAgent(target, {
        model: settings.model,
        alwaysApprove: settings.alwaysApprove
      })
      setSessionId(id)
      await refreshMeta()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [refreshMeta])

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

  const respondPermission = useCallback(async (decision: 'allow-once' | 'allow-always' | 'reject-once') => {
    if (!permission) return
    await window.grocky.respondPermission(permission.requestId, decision)
    setPermission(null)
  }, [permission])

  const updateSettings = useCallback(async (partial: Partial<AppSettings>) => {
    const next = await window.grocky.setSettings(partial)
    setSettingsState(next)
    return next
  }, [])

  const projectName = useMemo(() => {
    if (!cwd) return null
    const parts = cwd.replace(/\\/g, '/').split('/')
    return parts[parts.length - 1] || cwd
  }, [cwd])

  return {
    connection,
    cwd,
    projectName,
    sessionId,
    messages,
    recentProjects,
    sessions,
    settings,
    permission,
    error,
    busy,
    grokPath,
    scrollRef,
    openProject,
    sendPrompt,
    cancel,
    respondPermission,
    updateSettings,
    setError,
    refreshMeta
  }
}
