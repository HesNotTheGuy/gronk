import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  SessionLiveness,
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
import { raise, resolve, retire, type AppError, type ErrorScope } from '../lib/app-error'
import { needsSessionReload } from '../lib/session-nav'
import {
  NO_FOCUS,
  beginSwitch,
  belongsToFocus,
  mayReplaceView,
  confirmSwitch,
  sessionIdOf,
  type SessionFocus
} from '../lib/session-focus'
import {
  cachedTranscript,
  forgetTranscript,
  rememberTranscript,
  type CachedTranscript
} from '../lib/transcript-cache'
import { prependHead, splitForMount } from '../lib/transcript-mount'
import {
  isScrollbarClick,
  keyIntent,
  nextStick,
  touchIntent,
  wheelIntent,
  type StickCause
} from '../lib/scroll-stick'
import { useAppSettings } from './useAppSettings'
import { useAuth } from './useAuth'
import { useDrafts } from './useDrafts'
import { useQueue } from './useQueue'
import { useCliInstall } from './useCliInstall'
import { useDataLocation } from './useDataLocation'
import { useExportNotice } from './useExportNotice'
import { usePlugins } from './usePlugins'
import { usePreview } from './usePreview'
import { useSessionCatalog } from './useSessionCatalog'

/**
 * A message coming back out of storage rather than off the wire.
 *
 * Nothing restored is still streaming, and a user turn that was mid-flight when
 * the app closed is shown as sent: the only send state worth persisting is a
 * failure, because that one still offers Retry.
 */
/**
 * Events that may only replace the view for a session this renderer has named.
 *
 * Both of these are announcements about one session, emitted once it is settled:
 * `session` names it, `session-resync` hands over its whole view. Neither is ever the
 * answer to an outstanding load, so requiring a name costs nothing.
 *
 * `history-replace`, `history-clear` and `history-done` are NOT here, and that is a
 * known gap rather than an oversight. They ARE the answer to a load, and a load can
 * resolve to an id the renderer has not heard yet — clicking one session and having
 * main answer with another is a real path, pinned by "A LOAD THAT RESOLVES TO A
 * DIFFERENT ID STILL PAINTS ITS HISTORY". Requiring a name there drops the history of
 * the conversation the user just opened, which is worse than the leak it closes.
 * Fixing it properly means main saying which request a history event answers.
 */
const REPLACES_THE_VIEW = new Set(['session', 'session-resync'])

function restored(m: ChatMessage): ChatMessage {
  return {
    ...m,
    streaming: false,
    sendStatus:
      m.role === 'user'
        ? m.sendStatus === 'failed'
          ? ('failed' as const)
          : ('sent' as const)
        : m.sendStatus
  }
}

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
  const [sessionId, setSessionIdState] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  /**
   * The banner's error, tagged with what it is about. The rule for when it
   * stops being shown lives in `src/lib/app-error.ts`; nothing here should
   * decide that inline. Every write goes through one of the three helpers
   * below, which is what makes the rule greppable instead of spread across the
   * handlers.
   */
  const [appError, setAppError] = useState<AppError | null>(null)
  const [busy, setBusy] = useState(false)
  /**
   * True while opening a project or restoring a session: UI shows a skeleton
   * (or a light banner over existing messages) so the window does not look hung
   * during agent boot / store reads.
   */
  const [hydrating, setHydrating] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  /**
   * What every live session is doing, keyed by id.
   *
   * The only thing in this hook that describes sessions other than the one on
   * screen. Everything else here is singular on purpose: the focus gate below
   * guarantees a background session never writes the transcript, and making
   * those maps would multiply the surface without PR 2 needing it.
   */
  const [sessionLiveness, setSessionLiveness] = useState<Record<string, SessionLiveness>>({})
  const [historySource, setHistorySource] = useState<string | null>(null)
  /** Token/cost totals for the live session: null until the first turn completes. */
  const [usage, setUsage] = useState<SessionUsage | null>(null)
  const [activePlan, setActivePlan] = useState<ActivePlan | null>(null)
  const [planCollapsed, setPlanCollapsed] = useState(false)
  /** home | chat | project. Drives shell navigation */
  const [surface, setSurface] = useState<AppSurface>('home')
  /**
   * When true, main pane shows the browse home for that surface
   * (chat list / project tabs) instead of the live conversation.
   */
  const [browsing, setBrowsing] = useState(true)
  const [agentSurface, setAgentSurface] = useState<AgentSurface | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  /**
   * Set while the app is moving the viewport itself, so the scroll listener can
   * tell its own scroll from the user's. Every programmatic scroll lands at
   * distance zero, which is indistinguishable from the user arriving at the
   * bottom unless it is marked.
   */
  const programmaticScroll = useRef(false)
  const messagesRef = useRef<ChatMessage[]>([])

  /**
   * The session whose events are the conversation on screen.
   *
   * A ref rather than state, and that is the whole point of it. Selecting a
   * session has to change what the event handler accepts at the instant of the
   * click; a state update is not visible until React re-renders, and the events
   * this is meant to attribute arrive in between. The rule itself is in
   * `src/lib/session-focus.ts`.
   */
  const focusRef = useRef<SessionFocus>(NO_FOCUS)
  /**
   * The session on screen, mirrored into a ref so an async switch can read it.
   * State captured in a closure is whatever it was when the switch opened, which
   * is exactly the question a late switch needs the current answer to.
   */
  const shownRef = useRef<string | null>(null)
  const setSessionId = useCallback((id: string | null) => {
    shownRef.current = id
    setSessionIdState(id)
  }, [])
  /**
   * Which switch is the current one.
   *
   * Every entry point that opens a switch takes a ticket, and a switch the user
   * has moved on from commits nothing when it finally resolves. Without this,
   * clicking a session that has to boot and then clicking a live one left the
   * slower one to finish and overwrite the answer: `sessionId` became the session
   * you were no longer looking at, so prompts went there while the folder, the
   * file tree and the transcript stayed with the one on screen.
   *
   * It is a counter rather than a flag because there is no upper bound on how
   * many switches can be in flight; only the newest may commit.
   */
  const switchTicket = useRef(0)
  /**
   * What the last resync said about a session's turn.
   *
   * The tail of a switch clears `busy` as a safety net for a load that never
   * reports finishing. A session that is already live is focused before
   * `loadSession` returns, so its resync lands *before* that tail — and clearing
   * unconditionally threw away the one thing that knew a turn was still running,
   * which is most of what the resync is for. Keyed by session so an answer about
   * one cannot speak for another.
   */
  const resyncTurn = useRef<{ sessionId: string; open: boolean } | null>(null)
  const openSwitch = useCallback((requested: string | null): number => {
    focusRef.current = beginSwitch(requested)
    return (switchTicket.current += 1)
  }, [])
  const switchIsCurrent = useCallback((ticket: number) => switchTicket.current === ticket, [])

  /**
   * The last few transcripts this renderer already had, so going back to a
   * session you just left is a render rather than a round trip. Never a
   * substitute for `loadSession`: see the module comment.
   */
  const transcriptCache = useRef<CachedTranscript[]>([])

  /**
   * Set while a restore has painted its end but not yet its beginning.
   *
   * `messages` is genuinely partial in that window, and THREE things read it
   * expecting the whole conversation:
   *
   * - the debounced save-to-store effect, which would truncate the stored
   *   transcript to whatever is on screen;
   * - the `message-done` save, which is the dangerous one because it is
   *   immediate rather than debounced, and a turn really can complete during a
   *   restore: the composer stays live throughout one on purpose;
   * - the transcript cache, which would hand the truncation back on the next
   *   visit.
   *
   * All three go through `settledTranscript`. Anything added here that reads the
   * transcript to persist or to keep it has to as well, and this count is the
   * thing to re-derive rather than trust.
   */
  const partialMount = useRef<{ anchorId: string; head: ChatMessage[] } | null>(null)

  /**
   * The transcript as it will be, rather than as it is mid-paint.
   *
   * `prependHead` returning its input unchanged is how "the head already landed,
   * or this list belongs to another session now" arrives here, and it is the
   * only signal needed to drop the pending record.
   */
  const settledTranscript = useCallback((): ChatMessage[] => {
    const pending = partialMount.current
    const live = messagesRef.current
    if (!pending) return live
    const merged = prependHead(live, pending.head, pending.anchorId)
    if (merged === live) partialMount.current = null
    return merged
  }, [])

  /**
   * Paint a restored transcript end first.
   *
   * The reader is at the bottom, so the messages above the fold are latency and
   * nothing else. The tail is an ordinary update because it is what the user is
   * waiting for; the head is a transition because it is not, and React may pause
   * it to service the keyboard.
   *
   * A frame is yielded before the head so the tail actually reaches the screen:
   * scheduled in the same tick, React can batch the two into one render and the
   * split buys nothing.
   */
  const paintTranscript = useCallback((list: ChatMessage[]) => {
    const { tail, head, anchorId } = splitForMount(list)
    setMessages(tail)
    if (!head.length || !anchorId) {
      partialMount.current = null
      return
    }
    partialMount.current = { anchorId, head }
    requestAnimationFrame(() => {
      startTransition(() => {
        setMessages((prev) => prependHead(prev, head, anchorId))
      })
    })
  }, [])

  /**
   * The one way this hook moves the viewport. The flag is cleared on the next
   * frame rather than by the scroll handler, because assigning `scrollTop` when
   * it is already at the bottom fires no scroll event at all, and a flag waiting
   * to be consumed by an event that never comes would swallow the user's next
   * real scroll instead.
   */
  const pinToBottom = useCallback((el: HTMLElement) => {
    programmaticScroll.current = true
    el.scrollTop = el.scrollHeight
    requestAnimationFrame(() => {
      programmaticScroll.current = false
    })
  }, [])

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
   * this app has shipped before. Usual caveat for the pattern: call them from
   * effects and event handlers, never during render.
   */
  const refreshMetaImpl = useRef<() => Promise<void>>(async () => {})
  const refreshMeta = useCallback(() => refreshMetaImpl.current(), [])
  const restartAgentImpl = useRef<() => Promise<void>>(async () => {})
  const restartAgent = useCallback(() => restartAgentImpl.current(), [])

  /**
   * The three ways the banner changes. Every `setAppError` in this file goes
   * through one of them, so "what clears this?" is answered by reading
   * `app-error.ts` rather than by finding every call site.
   *
   * All three are stable: they close over nothing but the `useState` dispatch,
   * which is why they are safe in the dependency arrays below and safe to hand
   * to another hook.
   */
  /** An attempt is committing to do work. Call at the point of no return. */
  const beginAttempt = useCallback(
    (scope: ErrorScope) => setAppError((cur) => retire(cur, scope)),
    []
  )
  /** An attempt failed. */
  const failAttempt = useCallback(
    (scope: ErrorScope, message: string) => setAppError(raise(scope, message)),
    []
  )
  /** An attempt succeeded, which speaks only for its own scope. */
  const resolveAttempt = useCallback(
    (scope: ErrorScope) => setAppError((cur) => resolve(cur, scope)),
    []
  )

  /**
   * The banner reads a plain string, and `needsSessionReload` asks only whether
   * one is showing, so the scope stays inside this file.
   */
  const error = appError?.message ?? null

  /**
   * Dismiss, from the banner's own button. A raw string is treated as an agent
   * error because that is the only scope a caller outside this file could mean.
   */
  const setError = useCallback((value: string | null) => {
    setAppError(value === null ? null : raise('agent', value))
  }, [])

  /** The `export`-scoped half of the banner, handed to useExportNotice. */
  const beginExport = useCallback(() => beginAttempt('export'), [beginAttempt])
  const failExport = useCallback(
    (message: string) => failAttempt('export', message),
    [failAttempt]
  )

  const dataDir = useDataLocation(refreshMeta)
  const cliInstall = useCliInstall(refreshMeta)
  const exportState = useExportNotice(beginExport, failExport)

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

  // What is typed but not sent, per conversation. The composer keeps its own copy
  // while you are typing into it; this is where it lives when you are not.
  const { forgetDraft, ...draftState } = useDrafts(sessionId)

  // Messages written while a turn was running. Held here rather than refused at the
  // composer; the drain rule is below, on the end of a turn.
  const { takeNext, forgetQueue, holdQueue, releaseQueue, ...queueState } = useQueue(sessionId)

  // Same peeling: `hydrate` is refreshMeta's write-through, and the rest are how
  // the live-session flows below keep the browse lists honest.
  const {
    hydrate: hydrateCatalog,
    refreshSessions,
    setSessions,
    setChatWorkspacePath,
    chatWorkspacePath,
    renameSession: renameSessionInCatalog,
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
   * It writes into three separate concerns: settings/health, the session
   * catalog, and auth. It belongs to none of them. Splitting it into a
   * refresh per hook would turn one round of IPC into three and give up the
   * property every caller relies on: after `await refreshMeta()` the whole
   * picture is consistent, in a single React commit, instead of the UI tearing
   * through three intermediate states. The price is the two `hydrate` functions
   * and `setAuth`, write-throughs those hooks expose for this function alone.
   */
  refreshMetaImpl.current = async () => {
    const [
      projects,
      sess,
      s,
      path,
      modelList,
      auditList,
      healthStatus,
      authStatus,
      chatPath,
      notes
    ] = await Promise.all([
      window.gronk.getRecentProjects(),
      window.gronk.listSessions(),
      window.gronk.getSettings(),
      window.gronk.getGrokPath(),
      window.gronk.listModels(),
      window.gronk.getPermissionAudit(),
      window.gronk.getHealth(),
      window.gronk.getAuthStatus(),
      window.gronk.getChatWorkspacePath(),
      window.gronk.getProjectNotes()
    ])
    hydrateCatalog({
      recentProjects: projects,
      sessions: sess,
      chatWorkspacePath: chatPath,
      projectNotes: notes
    })
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
    // Which sessions are already live. A renderer can mount with agents
    // running: the window is recreated on macOS after the last one closes, and
    // reloading in development does the same. Without asking, the sidebar shows
    // nothing as live and the Stop control disappears for sessions that are.
    void window.gronk.getSessionLiveness().then(setSessionLiveness)

    const unsub = window.gronk.onEvent((event: MainToRendererEvent) => {
      // Does this belong to the conversation on screen? Read from a ref, not
      // from state: a switch has to take effect the instant it is requested,
      // and a state update scheduled by the click is not visible to an event
      // that arrives before React re-renders. Every event below this line has
      // been attributed.
      // Liveness is about sessions the user is NOT looking at, so it is read
      // before the focus gate rather than after it. Everything below that line
      // describes the conversation on screen; this describes the sidebar.
      if (event.type === 'session-liveness') {
        setSessionLiveness((prev) => {
          const next = { ...prev }
          if (event.liveness === null) delete next[event.sessionId]
          else next[event.sessionId] = event.liveness
          return next
        })
        return
      }

      if (!belongsToFocus(focusRef.current, sessionIdOf(event))) return
      // Events that REPLACE the view rather than adding to it take the stricter
      // test. The latitude above — accept any named session while a switch is open —
      // is for events that append, since a load can resolve to an id the renderer
      // has not heard yet. Applied to a replacement it means a session finishing its
      // boot while another switch is open repaints the conversation on screen as a
      // different one, which the save timer then writes to disk under the id the
      // renderer believes it is showing.
      if (REPLACES_THE_VIEW.has(event.type) && !mayReplaceView(focusRef.current, sessionIdOf(event))) {
        return
      }

      switch (event.type) {
        case 'connection':
          setConnection(event.state)
          if (event.error) failAttempt('agent', event.error)
          // The agent coming up settles the agent's own complaint and nothing
          // else: it is not evidence about a failed send or a failed export.
          // `setState('ready')` is never emitted with an error, so these two
          // cannot both fire for one event.
          if (event.state === 'ready') resolveAttempt('agent')
          break
        case 'session':
          // Main naming the session it is on is one of the two ways a switch
          // stops being open-ended; the other is the value start/load returns.
          // Whichever arrives first closes it.
          //
          // The guard above covers this: a session booting while a later switch is
          // open would otherwise announce itself into that switch and move
          // `sessionId` and the folder to a conversation the user had already left.
          focusRef.current = confirmSwitch(focusRef.current, event.sessionId)
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
        case 'session-resync':
          // Focusing a session that has been running in the background. The
          // renderer dropped its events while it was showing something else, so
          // the session hands over what it holds now.
          //
          // Messages are painted as they arrive, NOT through `restored()`: a turn
          // still streaming has to stay streaming, or the chunks still to come
          // would land in a message already drawn as finished. Plan and usage are
          // assigned rather than cleared, for the same reason — they belong to this
          // conversation, and the ones on screen belong to the one being left.
          paintTranscript(event.messages)
          // The source the load reported, not `'local'`: this event is not a
          // restore and claiming one puts "restored from cache" over a session
          // that came back from the agent, or over an empty new one.
          setHistorySource(event.source)
          // A turn can still be running. Without this the reply is visible and
          // the composer says nothing is happening, offers no way to stop it, and
          // takes a second prompt for a session that already has one open.
          resyncTurn.current = { sessionId: event.sessionId, open: event.hasOpenTurn }
          setBusy(event.hasOpenTurn)
          setUsage(event.usage)
          setActivePlan(() => {
            if (!event.plan) return null
            const entries = parsePlan(event.plan.plan)
            if (!entries.length) return null
            return {
              sessionId: event.sessionId,
              messageId: event.plan.messageId,
              entries,
              updatedAt: Date.now()
            }
          })
          stickToBottom.current = true
          break
        case 'history-replace':
          // Bulk restore from local cache: one paint, no clear/rebuild thrash.
          //
          // End first, then the rest in a transition. The transition does NOT
          // make the render faster; measured at 200 messages the work is the
          // same either way. What it changes is who owns the thread while it
          // happens, and a restore that keeps the keyboard is the whole point of
          // it. What the split changes is how much of that work stands between
          // the user and something to read. yieldPaint elsewhere is the same
          // instinct at the other end: it exists so the skeleton paints before
          // heavy main-process work, which neither of these does.
          paintTranscript(event.messages.map(restored))
          setHistorySource('local')
          setActivePlan(null)
          setUsage(null)
          break
        case 'history-done':
          setHistorySource(event.source)
          setBusy(false)
          setHydrating(false)
          // NOT `stickToBottom.current = true`, and neither is the paint above.
          //
          // Typing and scrolling are allowed while a session restores — that is
          // deliberate, and on a large session the restore takes long enough to read
          // during. Re-arming here overrode whatever the reader had done: scroll up
          // while it loads, and the moment it finished you were yanked to the end,
          // twice, by the two pins below. It reads as "I stopped scrolling and it
          // jumped", because the jump lands in the pause rather than during the gesture.
          //
          // Nothing is lost by dropping it. Opening a session sets this at the start of
          // the switch, and it begins true on a cold launch, so a reader who has not
          // touched anything still lands at the end. The pins below are already gated on
          // it, which is what makes them respect a gesture once the line above is gone.
          //
          // Second stick after images/layout settle so the viewport lands on the
          // real end of a long restored thread, not a mid-load height.
          requestAnimationFrame(() => {
            const el = scrollRef.current
            if (el && stickToBottom.current) pinToBottom(el)
            window.setTimeout(() => {
              const again = scrollRef.current
              if (again && stickToBottom.current) pinToBottom(again)
            }, 120)
          })
          void refreshSessions()
          break
        case 'user-message':
          // The main process writes the session row when the prompt is SENT, but
          // the list was only re-read on history-done and message-done. The
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
        case 'message-remove':
          setMessages((prev) => prev.filter((m) => m.id !== event.messageId))
          break
        case 'message-done': {
          setBusy(false)
          // Forget what the resync said about this session's turn, or the tail of a
          // switch still in progress would re-arm `busy` from an answer this event
          // has just made false. The tail runs after `refreshMeta`, which is long
          // enough for a turn to finish inside it.
          if (resyncTurn.current?.sessionId === event.sessionId) resyncTurn.current = null
          // A turn that was stopped, or that failed, does not release the next
          // queued message. Stopping usually means the user wants to say something
          // different, and sending what they queued before that is the opposite.
          if (event.stopReason === 'cancelled' || event.stopReason === 'error') {
            holdQueue(event.sessionId)
          }
          setMessages((prev) =>
            prev.map((m) => (m.id === event.messageId ? { ...m, streaming: false } : m))
          )
          // The save deliberately sits OUTSIDE the updater. React may call an
          // updater more than once for a single dispatch, and does so on every
          // render in development, so an IPC write in there ran twice per turn.
          // Updaters have to be pure.
          //
          // settledTranscript, not messagesRef: this write is immediate rather
          // than debounced, so a turn that completes while a restore has painted
          // its end and not yet its beginning would put those messages over the
          // whole stored conversation. That is reachable on purpose, because the
          // composer stays live during a restore: prompt into a long transcript,
          // and the turn can finish before the head lands.
          const doneSessionId = event.sessionId
          if (doneSessionId) {
            queueMicrotask(() => {
              const settled = settledTranscript().map((m) =>
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
          failAttempt('agent', event.message)
          setBusy(false)
          break
        // 'models' is useAppSettings', 'auth' is useAuth's, and both preview
        // events are usePreview's. Each of those hooks subscribes to onEvent
        // itself, and onEvent hands out independent subscriptions, so this
        // handler only sees the events that belong to the live conversation.
        default:
          break
      }
    })

    return unsub
    // paintTranscript, settledTranscript and the two error helpers are all
    // stable, so naming them here costs no re-subscription and keeps the
    // handler's reads honest.
  }, [
    refreshMeta,
    refreshSessions,
    refreshAudit,
    pinToBottom,
    paintTranscript,
    settledTranscript,
    failAttempt,
    resolveAttempt
  ])

  // Stick-to-bottom only while the user is actually at the end. Streaming
  // updates must not yank the viewport if they scrolled up to read earlier turns.
  //
  // The decision itself is in src/lib/scroll-stick.ts so it can be tested; this
  // effect only reads the DOM and names what kind of event happened. 0.1.8 tried
  // to fix the same complaint with one 120px threshold used in both directions,
  // which left the case the user hits most: scroll up a line or two mid-reply and
  // the next token drags you back, because 40px still read as "near the bottom".
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    // Carried between measurements so a scroll can be told from a reflow. A turn
    // ending makes the document shorter, and if the reader had scrolled up the
    // browser clamps scrollTop and reports a scroll they did not make.
    let previousScrollHeight = el.scrollHeight
    // Set by every intent handler, cleared by every measurement, so it always
    // means "since the last measurement". It is the only thing separating the
    // clamp above from a reader genuinely scrolling to the end while a turn
    // finishes.
    let gestureSinceMeasure = false

    const distance = () => el.scrollHeight - el.scrollTop - el.clientHeight
    const apply = (cause: StickCause) => {
      const scrollHeight = el.scrollHeight
      stickToBottom.current = nextStick({
        cause,
        distanceFromBottom: distance(),
        sticking: stickToBottom.current,
        scrollHeight,
        previousScrollHeight,
        gestureSinceMeasure
      })
      previousScrollHeight = scrollHeight
      // A gesture arms the flag; any measurement consumes it. Written as an
      // assignment rather than a pair of branches so there is no path that
      // leaves a stale gesture armed, which would make the next reflow look
      // like the reader had moved.
      gestureSinceMeasure = cause === 'gesture-up' || cause === 'gesture-down'
    }

    // A scroll the app caused says nothing about what the user wants, and it
    // always lands at distance zero, so answering from it would re-pin a
    // transcript the user had just scrolled away from on every stream tick.
    const onScroll = () => apply(programmaticScroll.current ? 'programmatic' : 'scroll')

    // Intent handlers exist to beat a real race, not for tidiness. A scroll event
    // is dispatched in the rendering steps of a later frame, so between the wheel
    // and the scroll there is a window in which a stream tick can render and
    // re-pin. These run in the input task, before the viewport has even moved.
    const onWheel = (e: WheelEvent) => apply(wheelIntent(e.deltaY))
    const onKeyDown = (e: KeyboardEvent) => {
      const cause = keyIntent(e.key, e.shiftKey)
      if (cause) apply(cause)
    }

    let touchStartY = 0
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0
    }
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY
      if (typeof y === 'number') apply(touchIntent(touchStartY, y))
    }

    // Dragging the scrollbar fires neither wheel nor keydown, so before this the
    // only handler that saw it was the one that re-pinned. Content clicks must
    // not count, which is what the gutter test is for.
    const onMouseDown = (e: MouseEvent) => {
      if (e.target !== el) return
      if (isScrollbarClick(e.offsetX, el.clientWidth)) apply('gesture-up')
    }

    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('keydown', onKeyDown)
    el.addEventListener('mousedown', onMouseDown)
    return () => {
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('keydown', onKeyDown)
      el.removeEventListener('mousedown', onMouseDown)
    }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottom.current) return
    pinToBottom(el)
    // Messages only: permission modals and plan panels used to force a jump
    // even when the user was reading older content above.
  }, [messages, pinToBottom])

  // Persist transcript while chatting
  useEffect(() => {
    if (!sessionId || messages.length === 0) return
    const t = setTimeout(() => {
      // settledTranscript, not messagesRef: a restore that has painted its end
      // and not yet its beginning would otherwise write those messages over the
      // whole stored transcript.
      void window.gronk.saveTranscript(sessionId, settledTranscript())
    }, 400)
    return () => clearTimeout(t)
  }, [messages, sessionId, settledTranscript])

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

  const selectSessionRef = useRef<
    ((session: SessionInfo) => Promise<void>) | null
  >(null)

  /** Yield a frame so React can paint the skeleton before heavy main-process work. */
  const yieldPaint = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })

  const openProject = useCallback(
    async (folder?: string | null, opts?: { forceNew?: boolean }) => {
      const authNow = await window.gronk.getAuthStatus()
      setAuth(authNow)
      if (!authNow.authenticated) {
        // An attempt to change session that failed, so it settles rather than
        // being left as though nothing was ever tried. Nothing is on screen and
        // no id was established, so a settled focus holding none refuses every
        // named event, which is what should happen.
        focusRef.current = confirmSwitch(focusRef.current, null)
        failAttempt(
          'agent',
          authNow.message ||
            'Sign in with your own Grok account before opening a project.'
        )
        return
      }

      let target = folder
      if (!target) {
        target = await window.gronk.selectFolder()
      }
      // Nothing was chosen, so nothing superseded the banner. Retiring on entry
      // instead would make cancelling this dialog quietly discard an error that
      // is still true.
      if (!target) return

      beginAttempt('agent')

      const sameProject =
        cwd &&
        pathsEqual(cwd, target) &&
        connection === 'ready' &&
        agentSurface === 'project'

      if (sameProject && !opts?.forceNew) {
        // Already here: no switch, so none is opened. Opening one before this
        // return would leave it open with nothing coming to close it, and an
        // open switch accepts every session's events.
        setSurface('project')
        setBrowsing(false)
        await refreshMeta()
        return
      }

      // Switch chrome immediately so the skeleton has somewhere to live.
      setSurface('project')
      setBrowsing(false)
      setAgentSurface('project')
      setCwd(target)
      setPermission(null)
      setActivePlan(null)
      setUsage(null)
      setHydrating(true)
      if (opts?.forceNew) {
        setMessages([])
        setSessionId(null)
        setHistorySource(null)
      }
      await yieldPaint()

      // Opening a project with history should resume the latest session, not
      // dump you on the empty "What should we build?" state. New session stays
      // explicit (New session / forceNew).
      //
      // No switch is open across this handoff, deliberately. selectSession owns
      // the whole thing when it takes over, and it has early returns of its own
      // that never reach its `beginSwitch`. A switch opened here would be left
      // open by those, with this function already returned and unable to close
      // it, and an open switch accepts every session's events for good.
      if (!opts?.forceNew && selectSessionRef.current) {
        try {
          const sessions = await window.gronk.listSessions()
          const latest = sessions
            .filter((s) => !s.archived && pathsEqual(s.cwd, target))
            .sort((a, b) => b.updatedAt - a.updatedAt)[0]
          if (latest) {
            await selectSessionRef.current(latest)
            return
          }
        } catch {
          /* fall through to a fresh agent */
        }
      }

      // Past every route out of here: this call is starting the agent itself,
      // so this is where the switch belongs. The id does not exist yet and
      // comes back from the boot.
      const ticket = openSwitch(null)
      setMessages([])
      setSessionId(null)
      setBusy(false)
      setHistorySource(null)

      /**
       * This switch is not the current one any more: the user clicked something
       * else while it was booting. Commit nothing — the newer switch owns the
       * screen — and put main back on the session that is actually shown, since
       * `start`/`loadSession` focused this one on the way through.
       */
      const abandoned = (): boolean => {
        if (switchIsCurrent(ticket)) return false
        // Only when the newer switch has already settled. One still in flight
        // focuses main itself when it lands, and asking on its behalf would
        // repaint the transcript it is about to paint anyway.
        if (focusRef.current.state === 'settled' && shownRef.current) {
          void window.gronk.focusSession(shownRef.current)
        }
        return true
      }

      try {
        const s = await window.gronk.getSettings()
        const { sessionId: id } = await window.gronk.startAgent(target, {
          model: s.model,
          alwaysApprove: s.alwaysApprove,
          forceNew: opts?.forceNew,
          surface: 'project'
        })
        if (abandoned()) return
        focusRef.current = confirmSwitch(focusRef.current, id)
        // Main focuses the session it just resolved, from inside start/loadSession,
        // before either returns, so there is nothing to ask for here. Asking again
        // repeated the whole repaint, and it asked *after* this switch was
        // confirmed — which for a switch the user had already abandoned meant the
        // other session's transcript painted over the one on screen.
        setSessionId(id)
        await refreshMeta()
        setHydrating(false)
      } catch (err) {
        // Nothing is coming to name the session now, so the switch is closed
        // here. Left open it would go on accepting every session's events.
        if (abandoned()) return
        focusRef.current = confirmSwitch(focusRef.current, null)
        failAttempt('agent', err instanceof Error ? err.message : String(err))
        setHydrating(false)
      }
    },
    [
      cwd,
      connection,
      refreshMeta,
      agentSurface,
      beginAttempt,
      failAttempt,
      openSwitch,
      switchIsCurrent
    ]
  )

  const openProjectRef = useRef(openProject)
  openProjectRef.current = openProject

  /** General Grok chat (website/X-style) via CLI, not a coding project */
  const openChat = useCallback(
    async (opts?: { forceNew?: boolean }) => {
      const authNow = await window.gronk.getAuthStatus()
      setAuth(authNow)
      if (!authNow.authenticated) {
        focusRef.current = confirmSwitch(focusRef.current, null)
        failAttempt(
          'agent',
          authNow.message ||
            'Sign in with your own Grok account before chatting.'
        )
        return
      }

      // Nothing above this can abandon the attempt, so this is the point of no
      // return: chat has no folder to pick.
      beginAttempt('agent')

      const chatPath =
        chatWorkspacePath || (await window.gronk.getChatWorkspacePath())
      setChatWorkspacePath(chatPath)

      const sameChat =
        cwd &&
        isChatWorkspace(cwd, chatPath) &&
        connection === 'ready' &&
        agentSurface === 'chat'

      if (sameChat && !opts?.forceNew) {
        // Already here: no switch, so none is opened. See openProject.
        setSurface('chat')
        setBrowsing(false)
        await refreshMeta()
        return
      }

      const ticket = openSwitch(null)
      setMessages([])
      setSessionId(null)
      // Owned here for the same reason openProject owns it: whichever switch is
      // the current one has to define this, because a switch that loses the race
      // returns without clearing what it set. Left to the loser, a session opened
      // and abandoned mid-boot stranded the skeleton over Chat with Send disabled.
      setHydrating(true)
      setCwd(chatPath)
      setBusy(false)
      setPermission(null)
      setHistorySource(null)
      setActivePlan(null)
      setUsage(null)
      setSurface('chat')
      setBrowsing(false)
      setAgentSurface('chat')

      /** See openProject: a switch the user moved on from commits nothing. */
      const abandoned = (): boolean => {
        if (switchIsCurrent(ticket)) return false
        // Only when the newer switch has already settled. One still in flight
        // focuses main itself when it lands, and asking on its behalf would
        // repaint the transcript it is about to paint anyway.
        if (focusRef.current.state === 'settled' && shownRef.current) {
          void window.gronk.focusSession(shownRef.current)
        }
        return true
      }

      try {
        const s = await window.gronk.getSettings()
        const { sessionId: id } = await window.gronk.startAgent(chatPath, {
          model: s.model,
          alwaysApprove: s.alwaysApprove,
          forceNew: opts?.forceNew,
          surface: 'chat'
        })
        if (abandoned()) return
        focusRef.current = confirmSwitch(focusRef.current, id)
        setSessionId(id)
        await refreshMeta()
        setHydrating(false)
      } catch (err) {
        if (abandoned()) return
        focusRef.current = confirmSwitch(focusRef.current, null)
        failAttempt('agent', err instanceof Error ? err.message : String(err))
        setHydrating(false)
      }
    },
    [
      chatWorkspacePath,
      cwd,
      connection,
      refreshMeta,
      agentSurface,
      beginAttempt,
      failAttempt,
      openSwitch,
      switchIsCurrent
    ]
  )

  /**
   * Backing implementation for the `restartAgent` handle above. Every caller
   * wants the same thing: the agent respawned on whichever surface is live,
   * with a new session. Each caller applies its own guard before asking.
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

  /** Chat browse home: previous chats (does not start a new agent) */
  const goChat = useCallback(() => {
    setSurface('chat')
    setBrowsing(true)
  }, [])

  /** Projects browse home: tabbed projects / sessions (no Explorer) */
  const goProjects = useCallback(() => {
    setSurface('project')
    setBrowsing(true)
  }, [])

  const selectSession = useCallback(
    async (session: SessionInfo) => {
      // Clicking the session you are already in used to tear it down and rebuild
      // it: clear the transcript, set hydrating, round trip through loadSession,
      // re-render every message, and switch the composer off for the duration.
      //
      // Deliberately NOT guarded on the id alone. A session that failed to load
      // has the same id as the one the user is clicking to retry, so guarding on
      // identity would make the retry click do nothing. needsSessionReload wants
      // the session to be both current AND healthy before it skips the work.
      if (
        !needsSessionReload({
          requestedId: session.id,
          activeId: sessionId,
          connection,
          error,
          hydrating
        })
      ) {
        // Still navigate: the click can come from a browse list, and the user
        // means "take me there" even when nothing needs reloading.
        setBrowsing(false)
        stickToBottom.current = true
        return
      }

      // Keep the transcript being left behind, so coming back to it is a render
      // rather than another read. Recorded before the auth probe: a sign-in that
      // fails is still a session the user was just reading.
      transcriptCache.current = rememberTranscript(
        transcriptCache.current,
        sessionId,
        settledTranscript()
      )

      const authNow = await window.gronk.getAuthStatus()
      setAuth(authNow)
      if (!authNow.authenticated) {
        // Reached by delegation as well as directly: opening a project resumes
        // its latest session through here, and this return is one of the two
        // that never gets as far as opening a switch below.
        focusRef.current = confirmSwitch(focusRef.current, null)
        failAttempt(
          'agent',
          authNow.message ||
            'Sign in with your own Grok account before restoring a session.'
        )
        return
      }

      beginAttempt('agent')
      // The clicked id is known, so this switch starts narrower than the ones a
      // project or chat opens. It still accepts anything until main confirms,
      // because a load can resolve to a different id and the history events
      // naming it arrive before that answer does.
      const ticket = openSwitch(session.id)

      /** See openProject: a switch the user moved on from commits nothing. */
      const abandoned = (): boolean => {
        if (switchIsCurrent(ticket)) return false
        // Only when the newer switch has already settled. One still in flight
        // focuses main itself when it lands, and asking on its behalf would
        // repaint the transcript it is about to paint anyway.
        if (focusRef.current.state === 'settled' && shownRef.current) {
          void window.gronk.focusSession(shownRef.current)
        }
        return true
      }

      // EVERY await from here down is inside this try, and that is the point of
      // where it starts rather than three statements lower. An open switch
      // accepts every session's events, so a rejection that escapes without
      // reaching the catch leaves it open for the rest of the run. Resolving the
      // chat workspace path can reject, and it sits before any of the work this
      // was originally wrapped around.
      try {
        const chatPath =
          chatWorkspacePath || (await window.gronk.getChatWorkspacePath())
        const isChat = isChatWorkspace(session.cwd, chatPath)

        setPermission(null)
        setBusy(true)
        setHydrating(true)
        setHistorySource(null)
        setActivePlan(null)
        setUsage(null)
        setSessionId(session.id)
        setCwd(session.cwd)
        setSurface(isChat ? 'chat' : 'project')
        setBrowsing(false)
        setAgentSurface(isChat ? 'chat' : 'project')
        stickToBottom.current = true
        await yieldPaint()

        // Paint the local transcript first so the user is reading history while
        // the agent process boots: loadSession will history-replace the same
        // data and then session/load in the background of the UI.
        //
        // A session visited earlier is already in memory, so that read is
        // skipped. The load below is not: the cache says what to draw, never
        // which session the agent is on.
        const held = cachedTranscript(transcriptCache.current, session.id)
        const local = held ?? (await window.gronk.getTranscript(session.id)).map(restored)
        if (local.length) {
          paintTranscript(local)
          setHistorySource('local')
        } else setMessages([])

        const result = await window.gronk.loadSession(session.id)
        if (abandoned()) return
        focusRef.current = confirmSwitch(focusRef.current, result.sessionId)
        setSessionId(result.sessionId)
        await refreshMeta()
        // history-done clears both of these; keep them here as a safety net for
        // the paths where it never arrives (e.g. an empty restore). They are set
        // together and cleared by the same event, so they are cleared together
        // here too. `busy` is the one that matters most: a stuck `hydrating`
        // shows a skeleton, a stuck `busy` disables the composer for a session
        // that is otherwise perfectly usable.
        setBusy(
          resyncTurn.current?.sessionId === result.sessionId && resyncTurn.current.open
        )
        setHydrating(false)
      } catch (err) {
        if (abandoned()) return
        focusRef.current = confirmSwitch(focusRef.current, null)
        failAttempt('agent', err instanceof Error ? err.message : String(err))
        setBusy(false)
        setHydrating(false)
      }
    },
    // The guard reads live state, so it has to be in the deps or a stale
    // closure would compare against whichever session was open when this
    // callback was last built.
    [
      refreshMeta,
      chatWorkspacePath,
      sessionId,
      connection,
      error,
      hydrating,
      beginAttempt,
      failAttempt,
      openSwitch,
      switchIsCurrent
    ]
  )
  selectSessionRef.current = selectSession

  const sendPrompt = useCallback(
    async (
      text: string,
      attachments: PromptAttachment[] = [],
      opts?: { replaceUserId?: string }
    ) => {
      const trimmed = text.trim()
      if ((!trimmed && attachments.length === 0) || busy || connection !== 'ready') return

      // Past the guard above, so the send is really happening.
      //
      // A person sending something is the answer to a queue held by a stopped turn:
      // they have decided what happens next, so the rest may follow this turn. The
      // held messages are on screen the whole time, so nothing resumes unseen.
      if (sessionId) releaseQueue(sessionId)
      beginAttempt('prompt')
      setBusy(true)
      stickToBottom.current = true

      let userId = opts?.replaceUserId
      if (userId) {
        // Retry: reuse the same bubble. Never spam a second copy
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
        const { messageId } = await window.gronk.sendPrompt(trimmed, {
          attachments,
          ...(sessionId ? { sessionId } : {})
        })
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
        failAttempt('prompt', message)
        setMessages((prev) =>
          prev.map((m) =>
            m.id === userId
              ? { ...m, sendStatus: 'failed' as const, error: message }
              : m
          )
        )
      }
    },
    [busy, connection, sessionId, beginAttempt, failAttempt, releaseQueue]
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
        // Already answered. Do not re-send / spam
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

  /**
   * Release one queued message when there is really room for it.
   *
   * Every condition here is a decision. `busy` and `connection` are the obvious
   * ones. `permission` is not: a turn waiting for the user to approve something is
   * not a finished turn, and draining into it races the approval. `hydrating` keeps
   * a queue from firing into a session still being read off disk. And a queue put on
   * hold by a stopped turn waits for a person, not for a timer.
   */
  useEffect(() => {
    if (queueState.queueHeld || queueState.queued.length === 0) return
    if (busy || hydrating || connection !== 'ready' || permission) return
    const next = takeNext()
    if (next) void sendPrompt(next.text, next.attachments)
  }, [
    queueState.queueHeld,
    queueState.queued,
    busy,
    hydrating,
    connection,
    permission,
    takeNext,
    sendPrompt
  ])

  const cancel = useCallback(async () => {
    await window.gronk.cancelPrompt(sessionId ?? undefined)
    setBusy(false)
  }, [])

  const respondPermission = useCallback(
    async (decision: 'allow-once' | 'allow-always' | 'allow-session' | 'reject-once') => {
      if (!permission) return
      await window.gronk.respondPermission(
        permission.requestId,
        decision,
        permission.sessionId || undefined
      )
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
      transcriptCache.current = forgetTranscript(transcriptCache.current, id)
      // A conversation nobody can open again has nothing to restore into.
      forgetDraft(id)
      forgetQueue(id)
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
    [sessionId, setSessions, restartAgent, forgetDraft, forgetQueue]
  )

  /**
   * Renaming changes the title and not one message, so the held transcript is
   * still accurate. It is dropped anyway: a cache whose invalidation rule is
   * "everything except the case I reasoned about" is the one that eventually
   * shows somebody a conversation that is not there.
   */
  const renameSession = useCallback(
    async (id: string, title: string) => {
      transcriptCache.current = forgetTranscript(transcriptCache.current, id)
      await renameSessionInCatalog(id, title)
    },
    [renameSessionInCatalog]
  )

  const archiveSession = useCallback(
    async (id: string) => {
      transcriptCache.current = forgetTranscript(transcriptCache.current, id)
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

  /**
   * Stop a session without opening it.
   *
   * Named explicitly rather than relying on the focused session, because the
   * whole point is acting on a row that is not on screen. The catalog is
   * refreshed afterwards so the row stops reading as live even if the liveness
   * event is missed.
   */
  const stopSession = useCallback(
    async (id: string) => {
      await window.gronk.stopAgent(id)
      await refreshSessions()
    },
    [refreshSessions]
  )

  const projectName = useMemo(() => {
    if (!cwd) return null
    if (agentSurface === 'chat') return 'Chat'
    return folderName(cwd)
  }, [cwd, agentSurface])

  /**
   * The app's public surface. Each spread is one focused hook's contribution;
   * the named entries are what this file still owns: the live conversation,
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
    ...draftState,
    ...queueState,
    ...catalog,
    renameSession,
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
    hydrating,
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
    sessionLiveness,
    stopSession,
    refreshMeta
  }
}
