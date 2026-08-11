import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ActivePlan,
  AuthStatus,
  ChatMessage,
  ProjectNotes,
  SessionUsage
} from '../../shared/types'
import { ChangesPanel } from './ChangesPanel'
import { nextRetained } from '../lib/agent-retention'
import {
  NOTE_MAX_CHARS,
  noteFor,
  noteWordCount,
  pendingNoteSave
} from '../lib/project-notes'
import {
  agentActivitySummary,
  collectAgentUnitsFromMessages,
  orderUnitsForDisplay
} from '../lib/agent-activity'
import { statusToDot } from '../lib/agent-dots'
import { costNote, detailCostLabel, summaryCostLabel } from '../lib/cost'
import { toolActivitySignature } from '../lib/tool-activity-sig'
import { shortenForDisplay } from '../lib/tool-format'

type TrayTab = 'plan' | 'agents' | 'usage' | 'notes' | 'changes'

/**
 * How long typing has to stop before a note is written.
 *
 * Every write re-serializes the whole store file and rolls the backup forward,
 * so this is not a keystroke-level save. Nothing is lost by waiting: the pending
 * text is flushed when the project changes and when the tray unmounts.
 */
const NOTE_SAVE_DEBOUNCE_MS = 600

function planStatusClass(status: string): string {
  const s = status.toLowerCase()
  if (s.includes('complete') || s === 'done') return 'done'
  if (s.includes('progress') || s === 'running' || s === 'active') return 'run'
  if (s.includes('fail') || s.includes('error')) return 'fail'
  return 'pending'
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k < 100 ? k.toFixed(1) : Math.round(k)}K`
  }
  const m = n / 1_000_000
  return `${m < 10 ? m.toFixed(2) : m.toFixed(1)}M`
}

function formatExact(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : '0'
}

function formatCost(usd?: number): string | null {
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return null
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function cachedShare(inputTokens: number, cached: number): number | null {
  if (inputTokens <= 0 || cached <= 0) return null
  return Math.min(100, Math.round((cached / inputTokens) * 100))
}

interface Props {
  /** Build surface only */
  showPlan: boolean
  /** Which session is on screen. A change of id is a restore, not new work. */
  sessionId: string | null
  plan: ActivePlan | null
  messages: ChatMessage[]
  usage: SessionUsage | null
  auth?: AuthStatus | null
  /**
   * The project folder this scratchpad belongs to, or null for no scratchpad.
   *
   * Null on the Chat surface deliberately. Chat runs in an app-local sandbox
   * whose path is superseded rather than kept, so a note filed under it would
   * quietly stop being findable; and "notes about this folder" means nothing for
   * a folder the user never chose.
   */
  /** Build surface only: Chat has no folder to compare. */
  showChanges: boolean
  notesCwd: string | null
  /** Every project's note, or null until they have loaded. */
  notes: ProjectNotes | null
  onSaveNote: (cwd: string, note: string) => void
}

/**
 * One strip above the composer for Plan, Agents, and Usage.
 *
 * Stacking three full-width panels left no room for the chat. This tray is a
 * single thin rail of tabs; only one body expands at a time, and empty sections
 * do not appear.
 */
export function SessionTray({
  showPlan,
  sessionId,
  plan,
  messages,
  usage,
  auth,
  showChanges,
  notesCwd,
  notes,
  onSaveNote
}: Props) {
  // Wide scan so status updates still reach units that started many turns ago.
  // Display history is the sticky `retained` list below — a 16-message window
  // made the AGENTS tab vanish as soon as chat moved on, which felt like
  // "only while something is running".
  //
  // Signature, not `messages`: every streaming token is a new messages array,
  // and re-extracting + setRetained on each one was a full second React pass
  // for zero agent change.
  const toolsSig = useMemo(() => toolActivitySignature(messages, 200), [messages])
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const fromMessages = useMemo(
    () => collectAgentUnitsFromMessages(messagesRef.current, { maxMessages: 200 }),
    // toolsSig is the gate; read messages via ref so a text-only token does not
    // re-extract, and a real tool change still sees the latest array.
    [toolsSig]
  )
  const [retained, setRetained] = useState<typeof fromMessages>([])
  /**
   * The first scan after a session appears is a restore snapshot, not live work.
   *
   * Without this the tray could not tell "ran while you were here" from "is in
   * the transcript", so reopening a session presented its entire history as
   * current: AGENTS 50, mostly red, with nothing actually wrong.
   */
  const restoreKey = useRef<string | null | undefined>(undefined)
  const [tab, setTab] = useState<TrayTab | null>(null)
  const [agentsDismissed, setAgentsDismissed] = useState(false)
  const prevLive = useRef(0)

  // Merge newly seen units into session memory. The first scan of a session is
  // a restore snapshot and keeps only what is still running; everything after it
  // is this session own work and is kept when it finishes.
  //
  // When toolsSig is unchanged, `fromMessages` keeps its previous reference, so
  // this effect does not run on pure text tokens — no setRetained, no second pass.
  useEffect(() => {
    const isRestoreSnapshot = restoreKey.current !== sessionId
    if (isRestoreSnapshot) restoreKey.current = sessionId
    // An empty scan mid-session drops nothing: the unit is still this session own
    // work even once its tool call has scrolled out of the window.
    if (!isRestoreSnapshot && fromMessages.length === 0) return
    setRetained((prev) => {
      const next = nextRetained({ prev, incoming: fromMessages, isRestoreSnapshot })
      // Same contents → keep the previous array so consumers do not re-render.
      if (
        next.length === prev.length &&
        next.every((u, i) => u === prev[i] || (u.id === prev[i]?.id && u.status === prev[i]?.status))
      ) {
        return prev
      }
      return next
    })
  }, [fromMessages, sessionId])

  const units = retained
  const agentSummary = useMemo(() => agentActivitySummary(units), [units])

  // ── Project notes ────────────────────────────────────────────────
  //
  // The draft carries the cwd it was loaded for. Without that pairing there is
  // one render, between the project changing and the draft being reloaded, where
  // the previous project's text is sitting in state next to the new project's
  // cwd; a save fired from that render files one project's notes under another.
  const [draft, setDraft] = useState<{ cwd: string; text: string } | null>(null)
  const notesReady = notes !== null
  const storedNote = noteFor(notes, notesCwd)
  const loadedFor = useRef<string | null>(null)
  /** Text typed but not yet written, kept so it can be flushed rather than lost. */
  const unsaved = useRef<{ cwd: string; text: string } | null>(null)
  const saveNote = useRef(onSaveNote)
  saveNote.current = onSaveNote

  const flushNote = useRef(() => {
    const pending = unsaved.current
    if (!pending) return
    unsaved.current = null
    saveNote.current(pending.cwd, pending.text)
  })

  // Leaving a project writes whatever it was holding. This runs before the
  // reload below, so the text it flushes still belongs to the project it was
  // typed into.
  const prevCwd = useRef<string | null>(null)
  useEffect(() => {
    if (prevCwd.current !== null && prevCwd.current !== notesCwd) flushNote.current()
    prevCwd.current = notesCwd
  }, [notesCwd])

  // Load once per project. Deliberately not re-run when `notes` changes: saving
  // writes the map straight back through, and re-seeding the box from it would
  // fight anyone still typing.
  useEffect(() => {
    if (!notesCwd || !notesReady) {
      loadedFor.current = null
      return
    }
    if (loadedFor.current === notesCwd) return
    loadedFor.current = notesCwd
    setDraft({ cwd: notesCwd, text: storedNote })
  }, [notesCwd, notesReady, storedNote])

  useEffect(() => {
    if (!notesCwd || !draft || draft.cwd !== notesCwd) return
    const next = pendingNoteSave(notes, notesCwd, draft.text)
    if (next === null) {
      unsaved.current = null
      return
    }
    unsaved.current = { cwd: notesCwd, text: next }
    const timer = setTimeout(() => flushNote.current(), NOTE_SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draft, notes, notesCwd])

  // Closing the session, or the tray disappearing, must not eat the last thing
  // typed into it.
  useEffect(() => () => flushNote.current(), [])

  const noteText = draft && draft.cwd === notesCwd ? draft.text : storedNote
  const noteWords = noteWordCount(noteText)

  /**
   * Bumped each time the Changes panel is opened, which is what makes it read.
   * Reading is a subprocess, so it happens when somebody asks to look and at no
   * other time.
   */
  const [changesOpened, setChangesOpened] = useState(0)
  const [changeCount, setChangeCount] = useState<number | null>(null)

  const hasChanges = showChanges
  const hasNotes = !!notesCwd
  const hasPlan = showPlan && !!plan && plan.entries.length > 0
  // Tab stays for the whole session once any agent has been seen, until ×.
  const hasAgents = !agentsDismissed && units.length > 0
  const hasUsage = !!usage && usage.turns > 0

  useEffect(() => {
    // Deliberately does NOT open the panel when work starts.
    //
    // It used to: a 0 to 1 transition in live agents called setTab('agents'),
    // so a panel appeared under the reader mid-sentence and pushed the
    // transcript. That is the same defect as the streaming scroll fixed in
    // 8042d18, arriving from the other direction, and it is worse here because
    // the user did not ask for the panel at all. The tab already reads
    // "AGENTS n live", and the dots under the spawning message now show the
    // same thing in place, so nothing is lost by waiting to be asked.
    //
    // Failures do not open it either. A failed dot takes the one hard accent
    // and is visible where the work was started, which is the point of having
    // a glance layer: it means the detail never has to interrupt.
    if (agentSummary.live > 0) {
      setAgentsDismissed(false)
    } else if (prevLive.current > 0 && tab === 'agents') {
      // Collapse the expanded body when the last agent finishes, but leave the
      // tab itself so the user can reopen history without waiting for new work.
      setTab(null)
    }
    prevLive.current = agentSummary.live
  }, [agentSummary.live, tab])

  // Drop a selected tab if its content disappears (plan finished clearing, etc.)
  useEffect(() => {
    if (tab === 'plan' && !hasPlan) setTab(null)
    if (tab === 'agents' && !hasAgents) setTab(null)
    if (tab === 'usage' && !hasUsage) setTab(null)
    if (tab === 'notes' && !hasNotes) setTab(null)
    if (tab === 'changes' && !hasChanges) setTab(null)
  }, [tab, hasPlan, hasAgents, hasUsage, hasNotes, hasChanges])

  // Consequence worth knowing: in a project session the rail is now always here,
  // because Notes is the one tab that cannot wait for content to exist before it
  // appears: there would be nowhere to write the first note. Chat sessions pass
  // no cwd and are unchanged.
  if (!hasPlan && !hasAgents && !hasUsage && !hasNotes && !hasChanges) return null

  const planDone = hasPlan
    ? plan!.entries.filter((e) => planStatusClass(e.status) === 'done').length
    : 0
  const planTotal = hasPlan ? plan!.entries.length : 0

  const sessionCost = hasUsage ? formatCost(usage!.totals.costUsd) : null
  const costSuffix = hasUsage ? summaryCostLabel(auth) : null
  const share = hasUsage
    ? cachedShare(usage!.totals.inputTokens, usage!.totals.cachedReadTokens)
    : null

  const select = (next: TrayTab) => {
    // The open/close decision is made here rather than inside the updater. An
    // updater has to be pure, and React calls it twice in development, which
    // would have started two subprocesses for one click.
    const opening = tab !== next
    if (opening && next === 'changes') setChangesOpened((n) => n + 1)
    setTab(opening ? next : null)
  }

  const orderedAgents = orderUnitsForDisplay(units)
  const agentChips = orderedAgents.slice(0, 8)
  const agentOverflow = orderedAgents.length - agentChips.length

  return (
    <div className={`session-tray ${tab ? 'open' : ''} ${agentSummary.live ? 'live' : ''}`}>
      <div className="session-tray-rail" role="tablist" aria-label="Session details">
        {hasPlan ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'plan'}
            className={`session-tray-tab ${tab === 'plan' ? 'active' : ''}`}
            onClick={() => select('plan')}
            title="Agent plan for this session"
          >
            <span className="session-tray-kicker">Plan</span>
            <span className="session-tray-value">
              {planDone}/{planTotal}
            </span>
          </button>
        ) : null}

        {hasAgents ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'agents'}
            className={`session-tray-tab ${tab === 'agents' ? 'active' : ''} ${agentSummary.live ? 'live' : ''}`}
            onClick={() => select('agents')}
            title="Spawned agents and background tasks"
          >
            <span className="session-tray-kicker">Agents</span>
            <span className="session-tray-value">
              {agentSummary.live > 0 ? (
                <span className="session-tray-live">{agentSummary.live} live</span>
              ) : (
                `${agentSummary.total}`
              )}
            </span>
          </button>
        ) : null}

        {hasUsage ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'usage'}
            className={`session-tray-tab ${tab === 'usage' ? 'active' : ''}`}
            onClick={() => select('usage')}
            title="Token use reported by the Grok CLI for this session"
          >
            <span className="session-tray-kicker">Usage</span>
            <span className="session-tray-value">
              {formatTokens(usage!.totals.totalTokens)}
              {sessionCost && costSuffix ? ` · ~${sessionCost}` : ''}
            </span>
          </button>
        ) : null}

        {hasChanges ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'changes'}
            className={`session-tray-tab ${tab === 'changes' ? 'active' : ''}`}
            onClick={() => select('changes')}
            title="What the agent has changed in this folder"
          >
            <span className="session-tray-kicker">Changes</span>
            <span className="session-tray-value">
              {changeCount === null ? '—' : `${changeCount} ${changeCount === 1 ? 'file' : 'files'}`}
            </span>
          </button>
        ) : null}

        {hasNotes ? (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'notes'}
            className={`session-tray-tab ${tab === 'notes' ? 'active' : ''}`}
            onClick={() => select('notes')}
            title="Scratchpad for this project folder"
          >
            <span className="session-tray-kicker">Notes</span>
            <span className="session-tray-value">
              {noteWords > 0 ? `${noteWords} ${noteWords === 1 ? 'word' : 'words'}` : '—'}
            </span>
          </button>
        ) : null}

        <span className="session-tray-spacer" />

        {tab === 'agents' ? (
          <button
            type="button"
            className="session-tray-dismiss"
            title="Hide agents until new work starts"
            aria-label="Hide agents"
            onClick={() => {
              setAgentsDismissed(true)
              setRetained([])
              setTab(null)
            }}
          >
            ×
          </button>
        ) : null}

        {tab ? (
          <button
            type="button"
            className="session-tray-collapse"
            title="Collapse"
            aria-label="Collapse session tray"
            onClick={() => setTab(null)}
          >
            ▾
          </button>
        ) : (
          <span className="session-tray-hint" aria-hidden>
            ▸
          </span>
        )}
      </div>

      {tab === 'plan' && hasPlan ? (
        <div className="session-tray-body" role="tabpanel">
          <ul className="plan-list">
            {plan!.entries.map((e) => (
              <li key={e.id} className={`plan-item ${planStatusClass(e.status)}`}>
                <span className="plan-dot" aria-hidden />
                <span className="plan-text">{e.content}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {tab === 'agents' && hasAgents ? (
        <div className="session-tray-body" role="tabpanel">
          {/*
            Detail list, not a second glance strip: status is the same dot tones
            as AgentDots (luminance hierarchy, one accent for fail). Labels stay
            so you can tell agents apart; kind tags and RUN/DONE words go.
            Paths in labels/titles run through shortenForDisplay so a home
            directory never lands in the tray (or a screenshot of it).
          */}
          <div className="agent-tray-list">
            {agentChips.map((u) => {
              const tone = statusToDot(u.status)
              // Tight cap: identity over provenance; long tool titles become noise.
              const label = shortenForDisplay(u.label, 48)
              const detail = u.detail ? shortenForDisplay(u.detail, 72) : ''
              return (
                <div
                  key={u.id}
                  className="agent-tray-row"
                  title={[label, detail, u.source ? shortenForDisplay(u.source, 72) : '']
                    .filter(Boolean)
                    .join('\n')}
                >
                  <span className={`agent-dot ${tone}`} aria-hidden />
                  <span className="agent-tray-label">{label}</span>
                </div>
              )
            })}
            {agentOverflow > 0 ? (
              <div className="agent-tray-more">+{agentOverflow} more</div>
            ) : null}
          </div>
          <p className="session-tray-note">From Grok tool calls only. No extra model narration.</p>
        </div>
      ) : null}

      {tab === 'changes' && hasChanges ? (
        <div className="session-tray-body changes-body-wrap" role="tabpanel">
          <ChangesPanel visibleKey={changesOpened} onCount={setChangeCount} />
        </div>
      ) : null}

      {tab === 'notes' && hasNotes ? (
        <div className="session-tray-body notes-body" role="tabpanel">
          {/*
            A textarea, and only ever a textarea. Notes are user-authored text
            that gets persisted and re-rendered, which is the exact shape the
            markdown surface is dangerous for, so this one never goes near it.
            A textarea's value is not parsed as anything, so there is no rendering
            decision here to get wrong later.
          */}
          <textarea
            className="project-note"
            value={noteText}
            disabled={!notesReady}
            maxLength={NOTE_MAX_CHARS}
            rows={6}
            spellCheck
            aria-label="Notes for this project"
            placeholder="Things to remember about this project. Snippets, decisions, what to pick up next."
            /*
              onInput rather than onChange, which is what the rest of the app
              uses. React fires it for exactly the same keystrokes, and it is the
              event the suite's jsdom harness can actually deliver: React 19's
              change plugin does not synthesize onChange from a dispatched input
              event outside a real browser, so onChange here would leave the
              whole save path with no test at all.
            */
            onInput={(e) => setDraft({ cwd: notesCwd!, text: e.currentTarget.value })}
          />
          <p className="session-tray-note">
            Plain text, one note per folder, saved with Gronk's own settings rather than in
            the project itself, so it is never committed by accident.
          </p>
        </div>
      ) : null}

      {tab === 'usage' && hasUsage ? (
        <div className="session-tray-body usage-detail" role="tabpanel">
          <div className="usage-cols">
            <UsageCol label="Session total" usage={usage!.totals} auth={auth} />
            {usage!.last ? <UsageCol label="Last turn" usage={usage!.last} auth={auth} /> : null}
          </div>
          <p className="usage-note session-tray-note">
            Reported by the Grok CLI. {costNote(auth)} The CLI compacts context on its own, so
            there is nothing here to manage.
          </p>
          {share !== null ? (
            <p className="session-tray-note muted">
              {share}% of this session&apos;s prompt tokens were reused from cache rather than
              read again
              {usage!.totals.cachedReadTokens
                ? ` (${formatExact(usage!.totals.cachedReadTokens)} tokens)`
                : ''}
              . Nothing here counts against a quota this app can see.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function UsageCol({
  label,
  usage,
  auth
}: {
  label: string
  usage: SessionUsage['totals']
  auth?: AuthStatus | null
}) {
  const share = cachedShare(usage.inputTokens, usage.cachedReadTokens)
  const cost = formatCost(usage.costUsd)
  const note = costNote(auth)
  return (
    <div className="usage-col">
      <div className="usage-col-head">{label}</div>
      <dl className="usage-grid">
        <div className="usage-cell">
          <dt>In</dt>
          <dd title={formatExact(usage.inputTokens)}>{formatTokens(usage.inputTokens)}</dd>
        </div>
        <div className="usage-cell">
          <dt>Out</dt>
          <dd title={formatExact(usage.outputTokens)}>{formatTokens(usage.outputTokens)}</dd>
        </div>
        <div className="usage-cell cached">
          <dt>Cached</dt>
          <dd
            title={`${formatExact(usage.cachedReadTokens)} prompt tokens were served from cache rather than read again`}
          >
            {formatTokens(usage.cachedReadTokens)}
            {/* The share says "reused", never a bare percentage. A large number with
                a bare % beside it reads as a fuel gauge — it was read that way, as
                "97% of my tokens are gone", when it means the opposite and is the
                number you want high. One word, at the point of reading, rather than
                an explanation further down the panel. */}
            {share !== null ? <span className="usage-share"> {share}% reused</span> : null}
          </dd>
        </div>
        <div className="usage-cell">
          <dt>Thinking</dt>
          <dd title={formatExact(usage.reasoningTokens)}>
            {formatTokens(usage.reasoningTokens)}
          </dd>
        </div>
        <div className="usage-cell">
          <dt>Calls</dt>
          <dd>{usage.modelCalls}</dd>
        </div>
        <div className="usage-cell">
          <dt>API time</dt>
          <dd>{formatDuration(usage.apiDurationMs)}</dd>
        </div>
        {cost ? (
          <div className="usage-cell">
            <dt>{detailCostLabel(auth)}</dt>
            <dd title={note}>~{cost}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  )
}
