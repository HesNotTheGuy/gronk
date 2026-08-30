/** Shared IPC + domain types between main and renderer. */

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'auto'
  | 'dontAsk'
  | 'bypassPermissions'
  | 'plan'

/**
 * What a live session is doing, as the sidebar shows it.
 *
 * Three answers, and the order matters when they overlap: a session that is
 * waiting on the user is `blocked` even though a turn is open, because that is
 * the one the user has to act on. `working` is a turn in flight. `idle` is an
 * agent that is up with nothing to do.
 */
export type SessionLiveness = 'idle' | 'working' | 'blocked'

export type ConnectionState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'error'
  | 'stopped'
  | 'loading'

/** Top-level app surface: home hub, general Grok chat, or coding project */
export type AppSurface = 'home' | 'chat' | 'project'

export type AgentSurface = 'chat' | 'project'

export interface SessionInfo {
  id: string
  cwd: string
  title?: string
  createdAt: number
  updatedAt: number
  /**
   * Where this session belongs in the UI.
   * `chat` = app-level chat (no coding folder); `project` = workspace folder agent.
   * Optional for older store entries — fall back to isChatWorkspace(cwd).
   */
  surface?: AgentSurface
  /** Soft-hide from main lists (can still restore later) */
  archived?: boolean
  archivedAt?: number
  /** Approx. messages in transcript — used for activity / frequency UI */
  messageCount?: number
  /** User prompts sent in this session */
  userTurns?: number
}

export interface ProjectContext {
  cwd: string
  name: string
  /** Pinned projects stay at the top of the recent list. */
  pinned?: boolean
}

/**
 * One scratchpad per project folder, keyed by normalized project cwd.
 *
 * Deliberately NOT a field on ProjectContext. That list is a most-recently-used
 * rail: `addRecentProject` caps it at 12 and `removeRecentProject` (whose whole
 * promise is that it "never deletes files") drops an entry outright. A note
 * riding on those rows would be destroyed by opening a thirteenth project or by
 * tidying the sidebar, neither of which reads as "throw my notes away".
 *
 * Held in the app's own store rather than as a file in the project folder: a
 * file there would need gitignore handling, could be committed by accident, and
 * would be readable by the agent working in that folder.
 */
export type ProjectNotes = Record<string, string>

/**
 * Ceiling on one note. Shared because both ends enforce it: the textarea stops
 * accepting input at this length and the IPC boundary refuses anything longer.
 *
 * The store is a single JSON file that every store operation reads and parses,
 * so an unbounded field in it is a performance cliff for everything else. The
 * cap is a refusal and never a truncation: silently dropping the tail of what
 * somebody wrote is the corruption FIX-R1 exists to prevent.
 */
export const NOTE_MAX_CHARS = 20_000

export type ToolCallStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface ToolCallInfo {
  toolCallId: string
  title: string
  /**
   * The tool's own name from the agent (`spawn_subagent`, `shell`, `read_file`).
   *
   * Distinct from `title`, which is a rendered description and contains whatever
   * the call was about — file paths, whole command lines. Anything classifying a
   * call must match on this: matching the title made every `Read` of a file whose
   * path contained "workflow" register as a running workflow.
   *
   * Optional permanently: transcripts written before this field exist on disk.
   */
  name?: string
  kind?: string
  status: ToolCallStatus
  rawInput?: unknown
  content?: unknown
  error?: string
}

export type MessageRole = 'user' | 'assistant' | 'system'

export type MessageSendStatus = 'sending' | 'sent' | 'failed'

/**
 * One piece of a turn, in the order the agent produced it.
 *
 * Grok narrates before each tool call, so a three-step image edit is text,
 * tool, text, tool, text. `text` and `toolCalls` are two parallel fields on one
 * message and cannot express that order: every narration was concatenated into
 * a single bubble rendered after every tool card, with the sentences run
 * together ("...regenerating.Editing the image...") and each introduction sitting
 * below the call it introduced.
 *
 * A tool part is a REFERENCE by id, not a copy. Status keeps streaming into the
 * `toolCalls` entry for the whole turn; duplicating it here would give the same
 * fact two homes and one of them would go stale.
 */
export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; toolCallId: string }

export interface ChatMessage {
  id: string
  role: MessageRole
  /** Accumulated assistant/user text */
  text: string
  /**
   * The turn's contents in arrival order, when the sender recorded them.
   *
   * Optional on purpose, and permanently. Transcripts are persisted, so every
   * conversation already on a user's disk predates this field. `text` and
   * `toolCalls` are still written exactly as before, which means a message with
   * no `parts` renders the way it always did and there is nothing to migrate.
   * Treat this as an index over the other two fields, never as a replacement:
   * anything that reads a whole turn's prose must keep reading `text`.
   */
  parts?: MessagePart[]
  /** Streaming thought/reasoning */
  thought?: string
  toolCalls?: ToolCallInfo[]
  createdAt: number
  streaming?: boolean
  error?: string
  /**
   * Outbound user-message delivery (renderer-only).
   * - sending: in flight
   * - sent: accepted by agent
   * - failed: not delivered — may show Retry once
   */
  sendStatus?: MessageSendStatus
  /** True when restored from history (not live stream) */
  fromHistory?: boolean
  /** Attached image previews (data URLs) for UI only */
  attachments?: PromptAttachment[]
}

/**
 * Extend the open text run, or start a new one.
 *
 * Streaming delivers a sentence a token at a time, so pushing a part per chunk
 * would shatter one narration into dozens of parts and, downstream, dozens of
 * bubbles. A chunk that lands on text is folded into it instead.
 *
 * Both the main process (for the persisted transcript) and the renderer (for
 * what is on screen) build parts from the same stream of chunks, and they must
 * agree, so they share this one function rather than each keeping a copy.
 */
export function appendTextPart(
  parts: MessagePart[] | undefined,
  text: string
): MessagePart[] {
  const next = parts ? [...parts] : []
  if (!text) return next
  const last = next[next.length - 1]
  if (last && last.kind === 'text') {
    next[next.length - 1] = { kind: 'text', text: last.text + text }
    return next
  }
  next.push({ kind: 'text', text })
  return next
}

/**
 * Record where a tool call sits in the turn.
 *
 * An id that is already placed is left alone: Grok announces a call once and
 * then streams status updates for the same id, and a permission prompt can
 * announce it a third time. Each of those would otherwise punch another slot
 * into the order and the card would appear once per update.
 */
export function appendToolPart(
  parts: MessagePart[] | undefined,
  toolCallId: string
): MessagePart[] {
  const next = parts ? [...parts] : []
  if (!toolCallId) return next
  if (next.some((p) => p.kind === 'tool' && p.toolCallId === toolCallId)) return next
  next.push({ kind: 'tool', toolCallId })
  return next
}

export interface PromptAttachment {
  id: string
  kind: 'file' | 'image'
  /** Absolute path for files, or display name for images */
  name: string
  path?: string
  /** Base64 payload without data: prefix (images) */
  data?: string
  mimeType?: string
  /** data URL for image preview in UI */
  previewUrl?: string
}

/** One session whose title or transcript matched a search query. */
export interface SessionSearchHit {
  sessionId: string
  /** Matched the title rather than a message body — ranked above body hits. */
  inTitle: boolean
  messageMatches: number
  /** Text around the first body match, or null when only the title matched. */
  snippet: string | null
  score: number
}

export interface PermissionRequest {
  /** JSON-RPC request id (number or string from the agent) */
  requestId: number | string
  sessionId: string
  toolCallId: string
  title: string
  kind?: string
  rawInput?: unknown
}

export type PermissionDecision =
  | 'allow-once'
  | 'allow-always'
  /** Allow this tool kind for the rest of the agent process (not persisted). */
  | 'allow-session'
  | 'reject-once'

export interface PermissionAuditEntry {
  id: string
  at: number
  sessionId: string
  cwd: string
  toolCallId: string
  title: string
  kind?: string
  decision: PermissionDecision | 'cancelled' | 'auto-allow'
  rawInputPreview?: string
}

/**
 * How hard the model thinks before answering.
 *
 * The set is closed here because the value becomes the argument of
 * `--reasoning-effort`, and the CLI does not validate it: `--effort banana` is accepted
 * at parse time and the session simply runs with whatever that meant. So this list is
 * the only gate.
 *
 * `xhigh` is new with grok-4.6 — 4.5 offers three levels, 4.6 offers four — which is
 * why the levels a picker may show come from the model rather than from this type.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']

/** One level as the agent describes it. Label and description are the agent's own words. */
export interface ReasoningEffortOption {
  id: ReasoningEffort
  label: string
  description?: string
}

/**
 * One slash command the agent supports in this session, from
 * `initialize._meta.availableCommands`. Agent-supplied text: render as plain text
 * only, never as markdown or a link.
 */
export interface AgentCommand {
  name: string
  description?: string
  /** Argument hint, e.g. "on|off" — display only, never parsed. */
  hint?: string
}

export interface ModelInfo {
  id: string
  name: string
  description?: string
  isDefault?: boolean
  /**
   * Levels THIS model offers, in the agent's own order, and whether it offers any.
   * Absent means the agent said nothing about effort for this model, which is not the
   * same as "supports none" — it is "we do not know", and a picker shows nothing.
   */
  supportsReasoningEffort?: boolean
  reasoningEfforts?: ReasoningEffortOption[]
  /** The level this model uses when nothing is chosen. */
  defaultReasoningEffort?: ReasoningEffort
  /** Context window in tokens, as reported by the agent. */
  contextTokens?: number
}

export interface PlanItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | string
  priority?: number
}

export interface ActivePlan {
  sessionId: string
  messageId: string
  entries: PlanItem[]
  updatedAt: number
}

export interface FileEntry {
  path: string
  name: string
  relative: string
  isDir: boolean
}

export type AuthState =
  | 'authenticated'
  | 'unauthenticated'
  | 'cli_missing'
  | 'unknown'
  | 'checking'

export type AuthMethod = 'none' | 'session' | 'api_key_env' | 'unknown'

export type LoginMethod = 'oauth' | 'device'

/**
 * Safe auth snapshot for the UI — never includes tokens or API keys.
 * Credentials live in the Grok CLI (`~/.grok/auth.json` or XAI_API_KEY env).
 */
export interface AuthStatus {
  state: AuthState
  authenticated: boolean
  method: AuthMethod
  /** Human-safe label only, e.g. "grok.com" — never an email/token */
  accountLabel?: string
  hasAuthFile?: boolean
  hasEnvApiKey?: boolean
  message?: string
}

export interface HealthStatus {
  grokFound: boolean
  grokPath: string | null
  nodeOk: boolean
  platform: string
  auth: AuthStatus
}

export interface AppSettings {
  model?: string
  /**
   * How hard the model thinks, for sessions started from now on.
   *
   * Absent means no `--reasoning-effort` flag is passed at all and each model uses its
   * own default, which is the shipped state. Read at spawn, so changing it does not
   * reach a session already running.
   */
  reasoningEffort?: ReasoningEffort
  /**
   * Grok CLI permission mode (`--permission-mode`) — the only permission fact
   * Gronk stores. `bypassPermissions` is YOLO and requires alwaysApproveAck.
   */
  permissionMode: PermissionMode
  /**
   * Bypass tool permission prompts (equivalent to --always-approve).
   * DERIVED, never persisted: the store computes it as
   * `permissionMode === 'bypassPermissions'` on every read. In a `setSettings`
   * patch it is the UI's YOLO toggle and folds back onto the mode.
   * Dangerous — must be confirmed in UI before enabling.
   */
  alwaysApprove: boolean
  /** User acknowledged YOLO risk at least once this install */
  alwaysApproveAck?: boolean
  /**
   * The app version whose release notes have been seen, per install.
   *
   * Survives an update, which is the whole point: a dismissed panel that comes back on the
   * next release looks broken rather than merely redundant. Absent means this install has
   * never recorded one, which is treated as a first run — nothing is shown, and the current
   * version is recorded so the next update has something to compare against.
   */
  seenNotesVersion?: string
  grokBinary?: string
  theme: 'dark' | 'light' | 'system'
  /** Custom dev command for the preview pane (defaults to `npm run dev`). */
  previewCommand?: string
}

// ── Data location ──────────────────────────────────────────────────
/**
 * Where Gronk keeps the transcript store and the chat sandbox.
 *
 * Deliberately NOT part of AppSettings: settings live inside the store, and the
 * store's own path cannot be read from inside itself. It is resolved from a small
 * pointer file in the default userData directory instead.
 */
export interface DataLocation {
  /** Directory currently holding gronk-store.json and chat-workspace/ */
  dataDir: string
  /** The app's default userData directory — where the pointer file always lives */
  defaultDir: string
  /** True when dataDir === defaultDir (no relocation in effect) */
  isDefault: boolean
  storePath: string
  chatWorkspacePath: string
  /** Size of the transcript store on disk, for the UI to show what would move */
  storeBytes?: number
  /**
   * Chat sandbox paths used before a move. The Grok CLI keys its own session
   * folders by cwd, so generated images from earlier sessions still live under
   * the old key — these are probed so a relocation does not orphan them.
   */
  previousChatWorkspaces?: string[]
}

export interface MoveDataResult {
  ok: boolean
  message: string
  location: DataLocation
}

// ── Activity calendar ──────────────────────────────────────────────
/** One day's worth of work, for the contribution-style heatmap. */
/** One day's work, counted. The same three numbers whatever is being counted. */
export interface DayCounts {
  /** Prompts the user sent: the honest measure of work done. */
  userTurns: number
  /** All messages, user and assistant. */
  messages: number
  /** Distinct sessions touched. */
  sessions: number
}

export interface DayActivity extends DayCounts {
  /** Local calendar day, `YYYY-MM-DD`. Local, not UTC: a day boundary the user
   *  does not recognise makes their own history look wrong. */
  date: string
  /**
   * The same day counted for Chat sessions only, and for Build sessions only.
   *
   * A session has exactly one surface, so the two are a partition of the day:
   * `chat.userTurns + build.userTurns === userTurns`. They exist so the heatmap
   * can be filtered without a second fetch and, more importantly, without a
   * second `peak`. Intensity is normalised against the busiest single day, and
   * a per-scope peak would make the same shade mean different amounts depending
   * on which filter was selected.
   */
  chat: DayCounts
  build: DayCounts
}

export interface ActivityCalendar {
  days: DayActivity[]
  /** Inclusive range actually covered, `YYYY-MM-DD`. */
  from: string
  to: string
  /** Highest userTurns in the range — the scale the heatmap normalises against. */
  peak: number
  totalUserTurns: number
  /** Consecutive days with activity ending today (or yesterday). */
  currentStreak: number
  longestStreak: number
}

// ── Usage / cost ───────────────────────────────────────────────────
/**
 * Token and cost accounting for one agent turn.
 *
 * The Grok CLI already reports this on the ACP stream as
 * `sessionUpdate: "turn_completed"` with a `usage` block — Gronk simply did not
 * handle that update type, so none of it reached the UI.
 */
export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** Prompt tokens served from cache — cheaper, and the reason cost is not linear in totalTokens. */
  cachedReadTokens: number
  reasoningTokens: number
  /** Model round trips in this turn; a tool-heavy turn makes several. */
  modelCalls: number
  apiDurationMs: number
  /**
   * Cost in USD, converted from the CLI's `costUsdTicks`.
   *
   * Observed: 450344000 ticks alongside 45428 tokens, and 702600000 alongside
   * 101298 — both resolve to plausible sub-dollar amounts at 1e9 ticks per USD
   * (nano-USD), which is the conversion used. Treat as an estimate for the user's
   * own awareness, never as a billing figure.
   */
  costUsd?: number
  /** Per-model breakdown when a turn spans more than one model. */
  perModel?: Record<string, { totalTokens: number; costUsd?: number }>
}

/** Running totals for the current session, accumulated from each turn. */
export interface SessionUsage {
  sessionId: string
  turns: number
  totals: TurnUsage
  /** Newest turn, so the UI can show "this turn" alongside the running total. */
  last?: TurnUsage
}

// ── Grok CLI version ───────────────────────────────────────────────
export type CliVersionStatus = 'ok' | 'newer-than-verified' | 'older-than-verified' | 'unknown'

/**
 * The CLI updates itself without asking. Gronk parses its `--json` output
 * against shapes verified at a specific version, so a field rename upstream
 * shows up as empty lists rather than an error. This makes the mismatch legible.
 */
export interface CliVersionInfo {
  /** e.g. "0.2.112" — parsed from `grok version --json` */
  current?: string
  /** e.g. "stable" */
  channel?: string
  /** The version Gronk's JSON parsing was actually verified against. */
  verifiedAgainst: string
  status: CliVersionStatus
  message?: string
}

/** Where the loaded store actually came from. */
export type StoreSource = 'file' | 'backup' | 'fresh' | 'unrecoverable'

/**
 * Whether the store loaded cleanly. Surfaced to the UI on purpose: a store that
 * failed to parse used to fall back to empty defaults silently, which is
 * indistinguishable from a first run — so a recovered or lost store looked
 * exactly like "the update wiped my sessions".
 */
export interface StoreHealth {
  source: StoreSource
  /** True when something was on disk that could not be read as written. */
  degraded: boolean
  message?: string
  /** The unreadable file, kept for manual rescue. Never deleted by the store. */
  corruptPath?: string
  schemaVersion: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  permissionMode: 'default',
  // Derived value for the default mode; the store strips it before writing.
  alwaysApprove: false,
  alwaysApproveAck: false,
  theme: 'dark'
}

/** UI labels for permission modes (Grok CLI compatible). */
export const PERMISSION_MODE_OPTIONS: Array<{
  id: PermissionMode
  label: string
  short: string
  description: string
  dangerous?: boolean
}> = [
  {
    id: 'default',
    label: 'Default',
    short: 'Ask',
    description: 'Prompt for tools that are not auto-approved'
  },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    short: 'Edits',
    description: 'Auto-approve file edits; still ask for shell/network'
  },
  {
    id: 'auto',
    label: 'Auto',
    short: 'Auto',
    description: 'Broader auto-approval for common agent actions'
  },
  {
    id: 'plan',
    label: 'Plan',
    short: 'Plan',
    description: 'Plan-first mode — design approach before writing code'
  },
  {
    id: 'dontAsk',
    label: "Don't ask",
    short: 'Strict',
    description: 'Deny anything without an explicit allow rule'
  },
  {
    id: 'bypassPermissions',
    label: 'Bypass all',
    short: 'YOLO',
    description: 'Auto-approve tools (dangerous — same as --always-approve)',
    dangerous: true
  }
]

/** Events pushed from main → renderer */
export type MainToRendererEvent =
  /**
   * `sessionId` is absent only before a session exists, which is the boot
   * window: `starting` and the failures that can happen inside it. Once there is
   * a session, every connection change names it, so the renderer can tell a
   * background agent's trouble from the one it is showing.
   */
  | { type: 'connection'; state: ConnectionState; error?: string; sessionId?: string }
  | { type: 'session'; sessionId: string; cwd: string }
  | { type: 'history-clear'; sessionId: string; forRequest?: string }
  /**
   * Replace the entire transcript in one shot (local cache restore). Prefer this
   * over history-clear + N user-message events so the UI does not thrash.
   */
  /**
   * The three history events carry `forRequest` when they answer a specific load.
   *
   * Without it the renderer cannot tell "the load I asked for resolved to an id I have not
   * heard yet" from "an unrelated session finished booting" — the events look identical, so
   * it had to accept both, and accepting the second repaints the conversation being read as
   * a different one. The id is the renderer's own, handed to `loadSession` and echoed back.
   */
  | {
      type: 'history-replace'
      sessionId: string
      messages: ChatMessage[]
      forRequest?: string
    }
  /**
   * Everything the view of one session holds, handed over on focus.
   *
   * Not `history-replace`: that one restores a conversation nobody is watching
   * live, so it stamps every message finished and drops the plan and the token
   * count. This one describes a session that may be mid-turn, so the messages
   * arrive exactly as the session holds them and the other two arrive with them
   * rather than being cleared. One event because the three have to land together;
   * a transcript next to another conversation's token count is its own wrong answer.
   */
  | {
      type: 'session-resync'
      sessionId: string
      messages: ChatMessage[]
      usage: SessionUsage | null
      plan: { messageId: string; plan: unknown } | null
      /** What `history-done` reported at load, null before one has completed. */
      source: 'acp' | 'local' | 'mixed' | 'empty' | null
      /** Whether a turn is still running, so the composer can offer to stop it. */
      hasOpenTurn: boolean
      /** What this session is running — not what settings would start next. */
      model?: string
      permissionMode: PermissionMode | null
      /** The level this session was spawned with; null when no flag was passed. */
      reasoningEffort?: ReasoningEffort | null
      /** Slash commands this session's agent accepts. */
      commands?: AgentCommand[]
    }
  | {
      type: 'history-done'
      sessionId: string
      source: 'acp' | 'local' | 'mixed' | 'empty'
      forRequest?: string
    }
  | { type: 'user-message'; sessionId: string; message: ChatMessage }
  | { type: 'message-chunk'; sessionId: string; messageId: string; text: string }
  | { type: 'thought-chunk'; sessionId: string; messageId: string; text: string }
  | { type: 'tool-call'; sessionId: string; messageId: string; toolCall: ToolCallInfo }
  | {
      type: 'tool-call-update'
      sessionId: string
      messageId: string
      toolCallId: string
      patch: Partial<ToolCallInfo>
    }
  | { type: 'message-done'; sessionId: string; messageId: string; stopReason?: string }
  /**
   * Take a message back off screen.
   *
   * Only for one that never had content: a prompt creates the assistant bubble before
   * the agent answers, and a call that fails immediately would otherwise leave a blank
   * one in the transcript for good.
   */
  | { type: 'message-remove'; sessionId: string; messageId: string }
  /**
   * `request: null` clears the prompt. It carries the session id too, so a
   * background session clearing its own queue cannot take down the dialog the
   * user is looking at.
   */
  | { type: 'permission-request'; request: PermissionRequest | null; sessionId?: string }
  | { type: 'plan'; sessionId: string; messageId: string; plan: unknown }
  | { type: 'models'; models: ModelInfo[]; current?: string }
  | { type: 'commands'; commands: AgentCommand[]; sessionId?: string }
  | { type: 'auth'; auth: AuthStatus }
  | { type: 'error'; message: string; sessionId?: string }
  /**
   * Something failed in the main process outside any turn.
   *
   * Deliberately not `error`: that one is a turn's failure and clears `busy`, so
   * routing a stray rejection through it re-opens the composer under an agent
   * that is still streaming, and contradicts the banner standing beside it.
   */
  | { type: 'app-error'; message: string }
  | {
      type: 'preview-status'
      running: boolean
      url: string | null
      cwd: string | null
      /** Showing in its own window rather than the docked pane. */
      poppedOut?: boolean
      error?: string
    }
  | { type: 'preview-log'; text: string }
  | { type: 'usage'; sessionId: string; usage: SessionUsage }
  /**
   * What a live session is doing, for the sidebar.
   *
   * `null` means it is no longer live. Deliberately NOT a member of
   * `ConnectionState`: that union answers "can this session be typed into",
   * every arm of it is enumerated by hand in several places, and a session that
   * is working is `ready` for all of them.
   */
  | { type: 'session-liveness'; sessionId: string; liveness: SessionLiveness | null }

// ── Plugins & Skills (Grok CLI plugin system) ──────────────────────
export type PluginStatus = 'installed' | 'available' | 'disabled'

export interface PluginComponent {
  name: string
  description?: string
}

export interface PluginComponents {
  skills?: PluginComponent[]
  mcpServers?: PluginComponent[]
  commands?: PluginComponent[]
  agents?: PluginComponent[]
  hooks?: PluginComponent[]
}

export interface Plugin {
  name: string
  version?: string | null
  description?: string
  /** Source marketplace name, e.g. "xAI Official" */
  marketplace?: string
  category?: string
  status: PluginStatus
  enabled?: boolean
  /** Derived from components.* (the flat skill_count/has_* fields are unreliable) */
  skillCount: number
  hasHooks: boolean
  hasAgents: boolean
  hasMcp: boolean
  components?: PluginComponents
  /** Pinned commit for marketplace entries — shown in the trust modal */
  sha?: string
  sourceUrl?: string
}

export interface MarketplaceSource {
  name: string
  kind: string
  url?: string
  branch?: string | null
}

export type McpTransport = 'stdio' | 'http' | 'sse'
export type McpScope = 'user' | 'project'

export interface McpServer {
  name: string
  transport: McpTransport
  scope: McpScope
  commandOrUrl?: string
  args?: string[]
  status?: 'ok' | 'error' | 'unknown'
  detail?: string
}

/** A skill on disk: a directory containing SKILL.md. */
export interface InstalledSkill {
  /** From the front matter, not the folder name. */
  name: string
  description?: string
  /** 'user' = you added it; 'bundled' = shipped with the Grok CLI. */
  source: 'user' | 'bundled'
  /** The folder it lives in, which can differ from the declared name. */
  directory: string
}

export interface PluginActionResult {
  ok: boolean
  message: string
  plugins?: Plugin[]
}

export interface McpActionResult {
  ok: boolean
  message: string
  servers?: McpServer[]
}

export interface McpAddInput {
  name: string
  commandOrUrl: string
  transport: McpTransport
  scope: McpScope
  args?: string[]
  env?: Record<string, string>
  headers?: Record<string, string>
}

export interface SendPromptOptions {
  attachments?: PromptAttachment[]
  /** Which session to send to. Absent means the one on screen. */
  sessionId?: string
}

/** Working-tree change kinds, as `git status` reports them. */
export type ChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'untracked'
  | 'renamed'
  | 'conflicted'

export interface ChangedFile {
  /** Repository-relative, forward slashes. */
  path: string
  status: ChangeStatus
  staged: boolean
}

/**
 * Working-tree changes in the agent's folder. Local git only: this carries no
 * branch, no remote and no pull-request state, because none of those is a
 * question about what the agent just did to these files.
 */
export interface WorkingTreeChanges {
  repo: boolean
  reason?: 'no-folder' | 'not-a-repo' | 'git-failed'
  message?: string
  files: ChangedFile[]
  truncated: boolean
}

export interface FileDiff {
  path: string
  status: ChangeStatus
  text: string
  truncated: boolean
  binary: boolean
}

export interface GronkApi {
  selectFolder: () => Promise<string | null>
  selectFile: (options?: {
    filters?: { name: string; extensions: string[] }[]
    title?: string
  }) => Promise<string | null>
  getSettings: () => Promise<AppSettings>
  setSettings: (partial: Partial<AppSettings>) => Promise<AppSettings>
  getRecentProjects: () => Promise<ProjectContext[]>
  addRecentProject: (cwd: string) => Promise<ProjectContext[]>
  /** Remove a folder from the recent rail only — never deletes files on disk. */
  removeRecentProject: (cwd: string) => Promise<ProjectContext[]>
  /** Pin or unpin a recent project (pinned sort first). */
  setRecentProjectPinned: (cwd: string, pinned: boolean) => Promise<ProjectContext[]>
  /**
   * Working-tree changes in the agent's folder. Ephemeral: the result is never
   * persisted, and nothing calls this on a render or a keystroke.
   */
  getGitChanges: () => Promise<WorkingTreeChanges>
  getGitFileDiff: (path: string) => Promise<FileDiff | { error: string }>
  /** Every project scratchpad, so the renderer can answer without a round trip. */
  getProjectNotes: () => Promise<ProjectNotes>
  /** Write one project's scratchpad. An empty note forgets it. Returns the new map. */
  setProjectNote: (cwd: string, note: string) => Promise<ProjectNotes>
  /**
   * Windows title-bar overlay colors. No-op on other platforms. Called when the
   * renderer resolves light/dark so the native chrome matches the theme.
   */
  setChromeTheme: (theme: 'dark' | 'light') => Promise<void>
  /** Put text on the OS clipboard (main-process write; for explicit Copy actions). */
  writeClipboard: (text: string) => Promise<void>
  startAgent: (
    cwd: string,
    options?: {
      model?: string
      /**
       * Per-start YOLO override. Folds onto the stored permission mode in the
       * main process and is still gated on the persisted acknowledgement; omit
       * it to boot with the mode as stored.
       */
      alwaysApprove?: boolean
      forceNew?: boolean
      /** project = coding agent; chat = conversational Grok (no project folder) */
      surface?: AgentSurface
    }
  ) => Promise<{ sessionId: string }>
  /** Dedicated sandbox folder for general chat sessions (not a user project) */
  getChatWorkspacePath: () => Promise<string>
  /** Named to stop a background session; unnamed stops the one on screen. */
  stopAgent: (sessionId?: string) => Promise<void>
  /** Which session's events are the conversation on screen. */
  focusSession: (sessionId: string | null) => Promise<void>
  getSessionLiveness: () => Promise<Record<string, SessionLiveness>>
  sendPrompt: (
    text: string,
    options?: SendPromptOptions
  ) => Promise<{ messageId: string }>
  /**
   * Switch a running session's model in place. Rejects when nothing is running, which
   * is the caller's signal to store the choice for the next session instead.
   *
   * Resolves with the id the agent settled on, not the one asked for.
   */
  setModel: (model: string, sessionId?: string) => Promise<{ model: string }>
  cancelPrompt: (sessionId?: string) => Promise<void>
  /**
   * `sessionId` is part of the address rather than a hint: request ids are
   * chosen per CLI child and start at one, so two live sessions use the same
   * numbers for different requests.
   */
  respondPermission: (
    requestId: number | string,
    decision: PermissionDecision,
    sessionId?: string
  ) => Promise<void>
  listSessions: () => Promise<SessionInfo[]>
  /** `requestId` is echoed on this load's history events so the renderer can claim them. */
  loadSession: (
    sessionId: string,
    requestId?: string
  ) => Promise<{ sessionId: string; restored: boolean }>
  getTranscript: (sessionId: string) => Promise<ChatMessage[]>
  /** Full-text search over every stored transcript. Empty query returns []. */
  searchSessions: (query: string) => Promise<SessionSearchHit[]>
  saveTranscript: (sessionId: string, messages: ChatMessage[]) => Promise<void>
  deleteSession: (sessionId: string) => Promise<SessionInfo[]>
  renameSession: (sessionId: string, title: string) => Promise<SessionInfo | null>
  archiveSession: (sessionId: string, archived?: boolean) => Promise<SessionInfo | null>
  /**
   * `empty` and `cancelled` are distinguished on purpose: a single null meant
   * both, so exporting a session with no transcript showed no dialog and no
   * message — indistinguishable from a broken menu item.
   */
  exportTranscript: (
    sessionId: string,
    format?: 'md' | 'json'
  ) => Promise<{ ok: true; path: string } | { ok: false; reason: 'empty' | 'cancelled' }>
  listProjectFiles: (
    cwd: string,
    query?: string,
    limit?: number
  ) => Promise<FileEntry[]>
  listModels: () => Promise<ModelInfo[]>
  getPermissionAudit: () => Promise<PermissionAuditEntry[]>
  getConnectionState: () => Promise<ConnectionState>
  getGrokPath: () => Promise<string | null>
  getHealth: () => Promise<HealthStatus>
  getAuthStatus: () => Promise<AuthStatus>
  login: (method?: LoginMethod) => Promise<{
    ok: boolean
    method: LoginMethod
    message: string
    deviceHint?: string
    auth: AuthStatus
  }>
  /** End a sign-in still waiting on a browser. True when there was one. */
  cancelLogin: () => Promise<boolean>
  logout: () => Promise<{ ok: boolean; message: string; auth: AuthStatus }>
  /** Install the Grok CLI via the official installer (only after explicit user consent). */
  installCli: () => Promise<{
    ok: boolean
    message: string
    grokPath: string | null
    installed: boolean
  }>
  /**
   * Read a local image file as a data URL for inline chat display.
   * Path may be absolute or session-relative (e.g. images/1.jpg).
   * Restricted to project cwd, chat workspace, and ~/.grok/sessions.
   */
  readLocalImage: (filePath: string) => Promise<{
    dataUrl: string
    path: string
    mimeType: string
    error?: undefined
  } | { dataUrl?: undefined; path?: string; mimeType?: undefined; error: string }>
  /** Reveal a local file in the OS file manager (Finder / Explorer). */
  revealLocalPath: (filePath: string) => Promise<{ ok: boolean; error?: string }>
  /** Did the transcript store load cleanly, or was it recovered / lost? */
  getStoreHealth: () => Promise<StoreHealth>
  /** Is the installed Grok CLI a version Gronk's parsing was verified against? */
  getCliVersion: () => Promise<CliVersionInfo>
  /** Per-day activity for the contribution heatmap. `days` defaults to 365. */
  getActivityCalendar: (days?: number) => Promise<ActivityCalendar>
  // Data location
  getDataLocation: () => Promise<DataLocation>
  /** Folder picker for a new data directory. Returns null if cancelled. */
  chooseDataDir: () => Promise<string | null>
  /** Copy-verify-swap the data directory. Refuses while an agent is running. */
  moveDataDir: (target: string) => Promise<MoveDataResult>
  /** Move back to the app's default userData directory. */
  resetDataDir: () => Promise<MoveDataResult>
  onEvent: (handler: (event: MainToRendererEvent) => void) => () => void
  // Dev preview pane
  previewStart: (cwd: string, command?: string) => Promise<{ ok: boolean; message: string }>
  previewStop: () => Promise<void>
  previewSetBounds: (rect: { x: number; y: number; width: number; height: number }) => void
  previewSetUrl: (url: string) => Promise<void>
  previewReload: () => Promise<void>
  /** Move the preview into its own window, or back into the pane. */
  previewPopOut: () => Promise<{ ok: boolean; message: string }>
  previewDock: () => Promise<void>
  previewStatus: () => Promise<{
    running: boolean
    url: string | null
    cwd: string | null
    /** Showing in its own window rather than the docked pane. */
    poppedOut?: boolean
    error?: string
  }>
  // Plugins & Skills
  listInstalledPlugins: () => Promise<Plugin[]>
  /** Skills on disk, from ~/.grok/skills and the CLI's bundled set. */
  listSkills: () => Promise<InstalledSkill[]>
  listAvailablePlugins: () => Promise<Plugin[]>
  listMarketplaces: () => Promise<MarketplaceSource[]>
  installPlugin: (source: string, trust: boolean) => Promise<PluginActionResult>
  enablePlugin: (name: string) => Promise<PluginActionResult>
  disablePlugin: (name: string) => Promise<PluginActionResult>
  uninstallPlugin: (name: string) => Promise<PluginActionResult>
  listMcpServers: () => Promise<McpServer[]>
  addMcpServer: (input: McpAddInput) => Promise<McpActionResult>
  removeMcpServer: (name: string, scope?: McpScope) => Promise<McpActionResult>
  mcpDoctor: (name?: string) => Promise<McpServer[]>
  platform: NodeJS.Platform
}
