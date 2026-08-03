import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ActivePlan,
  AgentSurface,
  AppSurface,
  ChatMessage,
  ConnectionState,
  MainToRendererEvent,
  PermissionRequest,
  PromptAttachment,
  SessionInfo,
  SessionUsage,
  ToolCallInfo
} from '../../shared/types'
import { appendTextPart, appendToolPart } from '../../shared/types'
import { folderName, isChatWorkspace, pathsEqual } from '../../shared/path'
import {
  createAssistantPlaceholder,
  createUserMessage,
  hasAssistantReplyAfter
} from '../lib/messages'
import { parsePlan } from '../lib/plan'
import { useAppSettings } from './useAppSettings'
import { useAuth } from './useAuth'
import { useCliInstall } from './useCliInstall'
import { useDataLocation } from './useDataLocation'
import { useExportNotice } from './useExportNotice'
import { usePlugins } from './usePlugins'
import { usePreview } from './usePreview'
import { useSessionCatalog } from './useSessionCatalog'

// ActivityCalendar.tsx imports these from this module. Re-exported so splitting
// the file changes no component's import path.
export { ACTIVITY_CALENDAR_DAYS, useActivityCalendar } from './useActivityCalendar'
export type { ActivityCalendarState } from './useActivityCalendar'

/**
 * Composes the focused hooks in this directory into the single object the app
 * talks to. The shape it returns is the public surface; `tests/use-gronk-surface.test.ts`
 * pins it member by member.
 */
export function useGronk() {
  // ── The live conversation: the state this file still owns ──────────
  const [connection, setConnection] = useState<ConnectionState>('idle')
  const [cwd, setCwd] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [historySource, setHistorySource] = useState<string | null>(null)
  /** Token/cost totals for the live session — null until the first turn completes. */
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const [activePlan, setActivePlan] = useState<ActivePlan | null>(null)
  const [planCollapsed, setPlanCollapsed] = useState(false)
  /** home | chat | project — drives shell navigation */
  const [surface, setSurface] = useState<AppSurface>('home')
  /**
   * When true, main pane shows the browse home for that surface
   * (chat list / project tabs) instead of the live conversation.
   */
  const [browsing, setBrowsing] = useState(true)
  const [agentSurface, setAgentSurface] = useState<AgentSurface | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  const messagesRef = useRef<ChatMessage[]>([])

  // ── Hooks that need nothing from the conversation ──────────────────
  // Plugins, marketplaces and MCP servers own themselves entirely; the preview
  // only ever needs to know which folder to serve.
  const plugins = usePlugins()
  const preview = usePreview(cwd)

  /**
   * Forward handles for the two callbacks the sub-hooks need from the composer.
   *
   * Both are circular: `refreshMeta` writes into state owned by hooks declared
   * below it while two of those hooks have to call it, and `restartAgent` is
   * built from `openProject`/`openChat`, which are declared after the hook that
   * needs them. Something has to be referenced before it is defined, and these
   * refs are that seam.
   *
   * Their identity never changes, which is the real point: a sub-hook can put
   * one straight into a dependency array and its effects will not re-fire every
   * render. That is the exact shape of the "Maximum update depth exceeded" loop
   * this app has shipped before. Usual caveat for the pattern — call them from
   * effects and event handlers, never during render.
   */
  const refreshMetaImpl = useRef<() => Promise<void>>(async () => {})
  const refreshMeta = useCallback(() => refreshMetaImpl.current(), [])
  const restartAgentImpl = useRef<() => Promise<void>>(async () => {})
  const restartAgent = useCallback(() => restartAgentImpl.current(), [])

  const dataDir = useDataLocation(refreshMeta)
  const cliInstall = useCliInstall(refreshMeta)
  const exportState = useExportNotice(setError)

  /**
   * Everything about the current conversation, gone. Only `useState` dispatches,
   * so its identity is stable and useAuth can depend on it safely.
   */
  const clearLiveSession = useCallback(() => {
    setMessages([])
    setSessionId(null)
    setCwd(null)
    setActivePlan(null)
    setUsage(null)
    setPermission(null)
    setBusy(false)
    setConnection('idle')
  }, [])

  // `setAuth` is peeled off: it is how the flows below hand this hook an
  // AuthStatus they already fetched. It is not part of the public surface.
  const { setAuth, ...authState } = useAuth({ refreshMeta, clearLiveSession })

  // Same peeling: `hydrate` is refreshMeta's write-through, and the rest are how
  // the live-session flows below keep the browse lists honest.
  const {
    hydrate: hydrateCatalog,
    refreshSessions,
    setSessions,
    setChatWorkspacePath,
    chatWorkspacePath,
    ...catalog
  } = useSessionCatalog()

  const {
    hydrate: hydrateSettings,
    refreshAudit,
    ...settingsState
  } = useAppSettings({ cwd, connection, restartAgent, setAuth })

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  /**
   * Stays in the composer, and stays one `Promise.all`, deliberately.
   *
   * It writes into three separate concerns — settings/health, the session
   * catalog, and auth — so it belongs to none of them. Splitting it into a
   * refresh per hook would turn one round of IPC into three and give up the
   * property every caller relies on: after `await refreshMeta()` the whole
   * picture is consistent, in a single React commit, instead of the UI tearing
   * through three intermediate states. The price is the two `hydrate` functions
   * and `setAuth` — write-throughs those hooks expose for this function alone.
   */
  refreshMetaImpl.current = async () => {
    const [projects, sess, s, path, modelList, auditList, healthStatus, authStatus, chatPath] =
      await Promise.all([
        window.gronk.getRecentProjects(),
        window.gronk.listSessions(),
        window.gronk.getSettings(),
        window.gronk.getGrokPath(),
        window.gronk.listModels(),
        window.gronk.getPermissionAudit(),
        window.gronk.getHealth(),
        window.gronk.getAuthStatus(),
        window.gronk.getChatWorkspacePath()
      ])
    hydrateCatalog({ recentProjects: projects, sessions: sess, chatWorkspacePath: chatPath })
    hydrateSettings({
      settings: s,
      grokPath: path,
      models: modelList,
      audit: auditList,
      health: healthStatus
    })
    setAuth(authStatus)
  }

  useEffect(() => {
    void refreshMeta()
    void window.gronk.getConnectionState().then(setConnection)

    const unsub = window.gronk.onEvent((event: MainToRendererEvent) => {
      switch (event.type) {
        case 'connection':
          setConnection(event.state)
          if (event.error) setError(event.error)
          if (event.state === 'ready') setError(null)
          break
        case 'session':
          setSessionId(event.sessionId)
          setCwd(event.cwd)
          // Resuming replays this session's completed turns *before* this event
          // arrives, so only drop the totals when they belong to another session.
          setUsage((prev) => (prev && prev.sessionId === event.sessionId ? prev : null))
          break
        case 'history-clear':
          setMessages([])
          setHistorySource(null)
          setActivePlan(null)
          setUsage(null)
          break
        case 'history-done':
          setHistorySource(event.source)
          setBusy(false)
          void refreshSessions()
          break
        case 'user-message':
          // The main process writes the session row when the prompt is SENT, but
          // the list was only re-read on history-done and message-done — so the
          // session you were actively typing into did not appear in the sidebar
          // until its first reply finished, under the heading "No sessions in
          // this project yet". The row already exists by now; this just looks.
          void refreshSessions()
          setMessages((prev) => {
            if (prev.some((m) => m.id === event.message.id)) {
              return prev.map((m) =>
                m.id === event.message.id ? { ...m, ...event.message } : m
              )
            }
            return [...prev, event.message]
          })
          break
        // Chunks and tool calls both extend `parts`, which is what puts a
        // narration above the call it introduces instead of merging every
        // narration in the turn into one trailing bubble. `text` and `toolCalls`
        // are still maintained in full: they are what a transcript written by an
        // older build has, and what the renderer falls back to.
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
                  parts: appendTextPart(undefined, event.text),
                  createdAt: Date.now(),
                  streaming: true
                }
              ]
            }
            return prev.map((m) =>
              m.id === event.messageId
                ? {
                    ...m,
                    text: m.text + event.text,
                    parts: appendTextPart(m.parts, event.text)
                  }
                : m
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
              return {
                ...m,
                toolCalls: tools,
                parts: appendToolPart(m.parts, event.toolCall.toolCallId)
              }
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
              // A permission prompt shows the gated call through this event
              // before any `tool-call` arrives, so the slot has to be claimed
              // here too. Repeat status updates fold into the existing one.
              return {
                ...m,
                toolCalls: tools,
                parts: appendToolPart(m.parts, event.toolCallId)
              }
            })
          )
          break
        case 'message-done': {
          setBusy(false)
          setMessages((prev) =>
            prev.map((m) => (m.id === event.messageId ? { ...m, streaming: false } : m))
          )
          // The save deliberately sits OUTSIDE the updater. React may call an
          // updater more than once for a single dispatch — it does so on every
          // render in development — so an IPC write in there ran twice per turn.
          // Updaters have to be pure; messagesRef holds the same list, written
          // by the effect that mirrors messages.
          const doneSessionId = event.sessionId
          if (doneSessionId) {
            queueMicrotask(() => {
              const settled = messagesRef.current.map((m) =>
                m.id === event.messageId ? { ...m, streaming: false } : m
              )
              void window.gronk.saveTranscript(doneSessionId, settled)
            })
          }
          void refreshSessions()
          void refreshAudit()
          break
        }
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
        case 'usage':
          setUsage(event.usage)
          break
        case 'error':
          setError(event.message)
          setBusy(false)
          break
        // 'models' is useAppSettings', 'auth' is useAuth's, and both preview
        // events are usePreview's. Each of those hooks subscribes to onEvent
        // itself — it hands out independent subscriptions — so this handler only
        // sees the events that belong to the live conversation.
        default:
          break
      }
    })

    return unsub
  }, [refreshMeta, refreshSessions, refreshAudit])

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
      void window.gronk.saveTranscript(sessionId, messagesRef.current)
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

      const authNow = await window.gronk.getAuthStatus()
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
        target = await window.gronk.selectFolder()
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
      setUsage(null)
      setSurface('project')
      setBrowsing(false)
      setAgentSurface('project')

      try {
        const s = await window.gronk.getSettings()
        const { sessionId: id } = await window.gronk.startAgent(target, {
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
      const authNow = await window.gronk.getAuthStatus()
      setAuth(authNow)
      if (!authNow.authenticated) {
        setError(
          authNow.message ||
            'Sign in with your own Grok account before chatting.'
        )
        return
      }

      const chatPath =
        chatWorkspacePath || (await window.gronk.getChatWorkspacePath())
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
      setUsage(null)
      setSurface('chat')
      setBrowsing(false)
      setAgentSurface('chat')

      try {
        const s = await window.gronk.getSettings()
        const { sessionId: id } = await window.gronk.startAgent(chatPath, {
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

  /**
   * Backing implementation for the `restartAgent` handle above. Every caller
   * wants the same thing — the agent respawned on whichever surface is live,
   * with a new session — and each applies its own guard before asking.
   */
  restartAgentImpl.current = async () => {
    if (agentSurface === 'chat') await openChat({ forceNew: true })
    else if (cwd) await openProject(cwd, { forceNew: true })
  }

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
      const authNow = await window.gronk.getAuthStatus()
      setAuth(authNow)
      if (!authNow.authenticated) {
        setError(
          authNow.message ||
            'Sign in with your own Grok account before restoring a session.'
        )
        return
      }

      const chatPath =
        chatWorkspacePath || (await window.gronk.getChatWorkspacePath())
      const isChat = isChatWorkspace(session.cwd, chatPath)

      setPermission(null)
      setBusy(true)
      setHistorySource(null)
      setActivePlan(null)
      setUsage(null)
      setSessionId(session.id)
      setCwd(session.cwd)
      setSurface(isChat ? 'chat' : 'project')
      setBrowsing(false)
      setAgentSurface(isChat ? 'chat' : 'project')
      stickToBottom.current = true

      try {
        const local = await window.gronk.getTranscript(session.id)
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

        const result = await window.gronk.loadSession(session.id)
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
        const { messageId } = await window.gronk.sendPrompt(trimmed, { attachments })
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
    await window.gronk.cancelPrompt()
    setBusy(false)
  }, [])

  const respondPermission = useCallback(
    async (decision: 'allow-once' | 'allow-always' | 'allow-session' | 'reject-once') => {
      if (!permission) return
      await window.gronk.respondPermission(permission.requestId, decision)
      setPermission(null)
      void refreshAudit()
    },
    [permission, refreshAudit]
  )

  /**
   * Deleting or archiving the session that is on screen has to empty the
   * conversation and respawn the agent, so these two stay here rather than in
   * useSessionCatalog with their read-only siblings.
   */
  const deleteSession = useCallback(
    async (id: string) => {
      const sess = await window.gronk.deleteSession(id)
      setSessions(sess)
      if (sessionId === id) {
        setMessages([])
        setSessionId(null)
        setActivePlan(null)
        setHistorySource(null)
        await restartAgent()
      }
    },
    [sessionId, setSessions, restartAgent]
  )

  const archiveSession = useCallback(
    async (id: string) => {
      await window.gronk.archiveSession(id, true)
      const sess = await window.gronk.listSessions()
      setSessions(sess)
      if (sessionId === id) {
        setMessages([])
        setSessionId(null)
        setActivePlan(null)
        setHistorySource(null)
        await restartAgent()
      }
    },
    [sessionId, setSessions, restartAgent]
  )

  const projectName = useMemo(() => {
    if (!cwd) return null
    if (agentSurface === 'chat') return 'Chat'
    return folderName(cwd)
  }, [cwd, agentSurface])

  /**
   * The app's public surface. Each spread is one focused hook's contribution;
   * the named entries are what this file still owns — the live conversation,
   * shell navigation, and the Settings panel toggle.
   *
   * `tests/use-gronk-surface.test.ts` pins every member here. Losing one is
   * silent otherwise: TypeScript is happy, the build is happy, and a screen
   * quietly stops working.
   */
  return {
    connection,
    cwd,
    projectName,
    sessionId,
    messages,
    ...catalog,
    chatWorkspacePath,
    surface,
    browsing,
    agentSurface,
    openChat,
    goHome,
    goChat,
    goProjects,
    permission,
    error,
    busy,
    ...settingsState,
    ...authState,
    showSettings,
    setShowSettings,
    ...exportState,
    ...cliInstall,
    ...preview,
    ...plugins,
    ...dataDir,
    historySource,
    usage,
    activePlan,
    planCollapsed,
    setPlanCollapsed,
    scrollRef,
    openProject,
    newChat,
    selectSession,
    sendPrompt,
    retryPrompt,
    cancel,
    respondPermission,
    deleteSession,
    archiveSession,
    setError,
    refreshMeta
  }
}
