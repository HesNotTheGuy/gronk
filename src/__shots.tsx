/**
 * Screenshot / visual-inspection harness. NOT part of the app, NOT shipped,
 * gitignored.
 *
 * Mounts the real <App/> in a plain browser against a fake `window.gronk`, so
 * states can be looked at without launching Electron and without a single byte
 * of the author's real data. Every project name, path, session and message here
 * is invented.
 *
 * A scenario is chosen with ?state=NAME. The point is coverage of the states
 * nobody has ever actually rendered: the activity heatmap shipped in v0.1.0
 * completely unstyled because every test asserted its data and no one looked at
 * it.
 *
 * Run: npx vite --config vite.shots.config.ts
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ErrorBoundary } from './components/ErrorBoundary'
import { App } from './App'
import './styles.css'

const HOUR = 3600_000
const DAY = 24 * HOUR
// Fixed instant so visual baselines do not drift with the calendar. The activity
// heatmap window ends on "today" and each square is keyed to its weekday, so a
// live Date.now() shifts ~1/7 of the grid every day (0 cells differ at +7 days,
// hundreds at +1). Midday local avoids any local-midnight rounding.
//
// MUST stay a date-time string with no timezone offset: that form parses as
// LOCAL. A date-only string like '2026-08-02' parses as UTC midnight, which is
// exactly what src/lib/calendar.ts warns about and would shift the grid a
// column for anyone west of Greenwich. Do not "simplify" this back to Date.now()
// or to a date-only literal — both have already broken this harness once.
const NOW = new Date('2026-08-02T12:00:00').getTime()

const SCENARIO = new URLSearchParams(location.search).get('state') || 'default'

/** Deterministic PRNG so the activity heatmap is identical on every capture. */
function makeRandom(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296
    return state / 4294967296
  }
}

/**
 * `YYYY-MM-DD` in the LOCAL zone, which is the day boundary the grid is laid out
 * against: src/lib/calendar.ts builds its dates through the local-time Date
 * constructor precisely so a square means the day the user thinks it means.
 *
 * `toISOString().slice(0, 10)` is UTC and disagrees for part of every day. West
 * of Greenwich, a capture taken after local 19:00 stamped every day with
 * tomorrow's key, which moved each one to the next weekday and rendered the
 * whole heatmap a row low against a baseline captured that same afternoon.
 */
function localDayKey(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${at.getFullYear()}-${month}-${day}`
}

/**
 * The heatmap window as local midnights, oldest first, ending on today.
 *
 * Steps the local calendar date rather than subtracting a fixed 24h, for the
 * reason dayKeyRange gives in electron/main/activity.ts: a DST transition makes
 * a day 23 or 25 hours long, so fixed-width arithmetic across one repeats a date
 * or skips it. Either way the grid silently lays out a square short, which is
 * the same class of failure as the UTC keys and just rarer, needing a capture
 * near local midnight to show up.
 */
function localDayWindow(count: number): Date[] {
  const cursor = new Date(NOW)
  cursor.setHours(0, 0, 0, 0)
  cursor.setDate(cursor.getDate() - (count - 1))
  const out: Date[] = []
  for (let i = 0; i < count; i++) {
    out.push(new Date(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

const PROJECTS = [
  { cwd: '/home/dev/projects/orbital-api', name: 'orbital-api' },
  { cwd: '/home/dev/projects/flux-dashboard', name: 'flux-dashboard' },
  { cwd: '/home/dev/projects/packet-relay', name: 'packet-relay' }
]

const CHAT_WORKSPACE = '/home/dev/.gronk/chat-workspace'

const SESSIONS = [
  {
    id: 's-orbital-1',
    cwd: PROJECTS[0].cwd,
    title: 'Rate limiter drops bursts under load',
    createdAt: NOW - 2 * HOUR,
    updatedAt: NOW - 18 * 60_000,
    surface: 'project' as const,
    messageCount: 24,
    userTurns: 9
  },
  {
    id: 's-flux-1',
    cwd: PROJECTS[1].cwd,
    title: 'Migrate charts to the new theme tokens',
    createdAt: NOW - 2 * DAY,
    updatedAt: NOW - 26 * HOUR,
    surface: 'project' as const,
    messageCount: 41,
    userTurns: 15
  },
  {
    id: 's-packet-1',
    cwd: PROJECTS[2].cwd,
    title: 'Retry backoff never resets after success',
    createdAt: NOW - 4 * DAY,
    updatedAt: NOW - 3 * DAY,
    surface: 'project' as const,
    messageCount: 12,
    userTurns: 5
  },
  {
    id: 's-chat-1',
    cwd: CHAT_WORKSPACE,
    title: 'Difference between a mutex and a semaphore',
    createdAt: NOW - 5 * HOUR,
    updatedAt: NOW - 4 * HOUR,
    surface: 'chat' as const,
    messageCount: 8,
    userTurns: 3
  },
  {
    id: 's-chat-2',
    cwd: CHAT_WORKSPACE,
    title: 'Explain CRDTs without the maths',
    createdAt: NOW - 6 * DAY,
    updatedAt: NOW - 6 * DAY,
    surface: 'chat' as const,
    messageCount: 14,
    userTurns: 6
  }
]

function buildActivity() {
  const random = makeRandom(20260127)
  type Counts = { userTurns: number; messages: number; sessions: number }
  const days: Array<Counts & { date: string; chat: Counts; build: Counts }> = []
  let peak = 0
  let total = 0

  // Oldest first, so i counts back from today and indexes from the far end.
  const dayWindow = localDayWindow(365)
  for (let i = 364; i >= 0; i--) {
    const at = dayWindow[364 - i]
    const weekday = at.getDay()
    const roll = random()
    const quiet = weekday === 0 || weekday === 6 ? 0.75 : 0.22
    const onHoliday = (i < 250 && i > 236) || (i < 96 && i > 88)
    const userTurns = roll < quiet || onHoliday ? 0 : 1 + Math.floor(random() * 14)

    if (userTurns > peak) peak = userTurns
    total += userTurns
    const messages = userTurns * 2 + (userTurns ? Math.floor(random() * 4) : 0)
    const sessions = userTurns ? 1 + Math.floor(random() * 2) : 0
    // Split so the scope filter has something to filter. Chat takes a third,
    // Build the rest, and the two always add back up to the day.
    const chatTurns = Math.floor(userTurns / 3)
    const chatMessages = Math.floor(messages / 3)
    const chatSessions = userTurns ? (chatTurns > 0 ? 1 : 0) : 0
    days.push({
      date: localDayKey(at),
      userTurns,
      messages,
      sessions,
      chat: { userTurns: chatTurns, messages: chatMessages, sessions: chatSessions },
      build: {
        userTurns: userTurns - chatTurns,
        messages: messages - chatMessages,
        sessions: sessions - chatSessions
      }
    })
  }

  let currentStreak = 0
  for (let i = days.length - 1; i >= 0 && days[i].userTurns > 0; i--) currentStreak++
  let longestStreak = 0
  let run = 0
  for (const day of days) {
    run = day.userTurns > 0 ? run + 1 : 0
    if (run > longestStreak) longestStreak = run
  }

  return {
    days,
    from: days[0].date,
    to: days[days.length - 1].date,
    peak,
    totalUserTurns: total,
    currentStreak,
    longestStreak
  }
}

const DIFF = `@@ -14,9 +14,13 @@ export class RateLimiter {
-  private tokens = this.capacity
+  private tokens: number
+  private lastRefill = Date.now()

-  allow(): boolean {
-    if (this.tokens <= 0) return false
-    this.tokens--
+  allow(cost = 1): boolean {
+    this.refill()
+    if (this.tokens < cost) return false
+    this.tokens -= cost
     return true
   }`

const TOOL_CALLS = [
  {
    toolCallId: 't1',
    title: 'src/limit/rate-limiter.ts',
    kind: 'read',
    status: 'completed' as const,
    rawInput: { path: 'src/limit/rate-limiter.ts' }
  },
  {
    toolCallId: 't2',
    title: 'src/limit/rate-limiter.ts',
    kind: 'edit',
    status: 'completed' as const,
    rawInput: { path: 'src/limit/rate-limiter.ts' },
    content: DIFF
  },
  {
    toolCallId: 't3',
    title: 'npm test -- rate-limiter',
    kind: 'execute',
    status: 'completed' as const,
    rawInput: { command: 'npm test -- rate-limiter' },
    content:
      '✓ refills over time (4 ms)\n✓ allows a burst up to capacity (2 ms)\n✓ rejects past capacity, then recovers (11 ms)\n\n3 passing'
  }
]

const ASSISTANT_TEXT = `The bucket never refills. \`tokens\` is initialised once from \`capacity\` and only ever decremented, so the limiter is really a **one-shot quota**: after the first \`capacity\` requests it refuses everything until the process restarts.

A token bucket needs to earn tokens back over time:

\`\`\`ts
private refill(): void {
  const elapsed = Date.now() - this.lastRefill
  const earned = (elapsed / 1000) * this.refillPerSecond
  if (earned < 1) return
  this.tokens = Math.min(this.capacity, this.tokens + earned)
  this.lastRefill = Date.now()
}
\`\`\`

I have applied that, plus a \`cost\` parameter so an expensive call can draw more
than one token. Tests cover the burst case that was failing.`

/**
 * The catalogue: one reply carrying far more images than a column can hold.
 *
 * The reported bug was a request for a set of vector graphics answered with
 * about fifty `![name](path)` lines, each rendering as a full width card some
 * 265px tall, plus a bordered error box for every file that was not there.
 * Nineteen present and six missing is enough to photograph the grid, the
 * wrapping and the collapsed failure line without the shot itself needing to be
 * thirteen thousand pixels tall.
 *
 * Names starting with `missing-` are the ones readLocalImage below refuses, so
 * the failure count in the picture is not a coincidence of ordering. One name
 * is far too long for a tile on purpose: a model names files by describing
 * them, and a caption that wraps to three lines on every tile is the tall reply
 * arriving back through the captions.
 */
const CATALOGUE = [
  'antenna',
  'orbital-transfer-vehicle-side-elevation',
  'beacon',
  'booster',
  'missing-bulkhead',
  'capsule',
  'dish',
  'gantry',
  'missing-gyro',
  'heat-shield',
  'ion-drive',
  'lander',
  'missing-mast',
  'manifold',
  'nozzle',
  'orbiter',
  'missing-pennant',
  'payload',
  'probe',
  'rover',
  'missing-regulator',
  'solar-array',
  'strut',
  'thruster',
  'missing-truss'
]

const CATALOGUE_TEXT = [
  'Here is the full set. Twenty-five line vectors, one SVG per file, all in the session folder:',
  ...CATALOGUE.map((name) => `![${name}](images/${name}.svg)`),
  'Tell me which of these you want in colour and I will re-run those.'
].join('\n\n')

/**
 * Four kinds of picture, because the awkward one is invisible rather than ugly.
 *
 * `clear` is dark ink on NO background, which is what an exported icon usually
 * is: on the dark theme it used to be a black square. `white` is the other
 * common export and the one that glares. `wide` is not square, so it proves the
 * tile letterboxes rather than crops. `dark` is the app's own house style.
 */
const CATALOGUE_ART = [
  // white background, dark ink
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iI2ZmZmZmZiIvPjxjaXJjbGUgY3g9IjEwMCIgY3k9IjEwMCIgcj0iNjIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzExMTExMSIgc3Ryb2tlLXdpZHRoPSIxMCIvPjxwYXRoIGQ9Ik02MiAxMzggTDEzOCA2MiIgc3Ryb2tlPSIjMTExMTExIiBzdHJva2Utd2lkdGg9IjEwIi8+PC9zdmc+',
  // transparent, dark ink
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj48cmVjdCB4PSIyOCIgeT0iMjgiIHdpZHRoPSIxNDQiIGhlaWdodD0iMTQ0IiBmaWxsPSJub25lIiBzdHJva2U9IiMxMDEwMTAiIHN0cm9rZS13aWR0aD0iMTIiLz48Y2lyY2xlIGN4PSIxMDAiIGN5PSIxMDAiIHI9IjI4IiBmaWxsPSIjMTAxMDEwIi8+PC9zdmc+',
  // dark background, light ink
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iIzEyMTUxNiIvPjxwYXRoIGQ9Ik00MCAxNjAgTDEwMCA0MCBMMTYwIDE2MCBaIiBmaWxsPSJub25lIiBzdHJva2U9IiNlYWZmZmIiIHN0cm9rZS13aWR0aD0iMTAiLz48L3N2Zz4=',
  // wide, white
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iMTIwIj48cmVjdCB3aWR0aD0iMzIwIiBoZWlnaHQ9IjEyMCIgZmlsbD0iI2ZmZmZmZiIvPjxyZWN0IHg9IjE2IiB5PSIxNiIgd2lkdGg9IjI4OCIgaGVpZ2h0PSI4OCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMTExMTExIiBzdHJva2Utd2lkdGg9IjYiLz48dGV4dCB4PSIxNjAiIHk9Ijc0IiBmaWxsPSIjMTExMTExIiBmb250LWZhbWlseT0ibW9ub3NwYWNlIiBmb250LXNpemU9IjM0IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIj5XSURFPC90ZXh0Pjwvc3ZnPg=='
]

/** Same path, same picture, every run: a baseline cannot be compared otherwise. */
function catalogueArt(path: string): string {
  let sum = 0
  for (let i = 0; i < path.length; i++) sum += path.charCodeAt(i)
  return CATALOGUE_ART[sum % CATALOGUE_ART.length]
}

const isCatalogue = SCENARIO === 'catalogue' || SCENARIO === 'light-catalogue'

function transcript(): unknown[] {
  const assistant: Record<string, unknown> = {
    id: 'm2',
    role: 'assistant',
    text: ASSISTANT_TEXT,
    thought:
      'The field is assigned from capacity at construction and never restored. That is a quota, not a bucket.',
    createdAt: NOW - 8 * 60_000,
    toolCalls: TOOL_CALLS
  }

  if (SCENARIO === 'streaming') {
    assistant.text = 'The bucket never refills. `tokens` is initialised once from `capacity` and'
    assistant.streaming = true
    assistant.toolCalls = [{ ...TOOL_CALLS[0], status: 'in_progress' }]
  }

  // 'lightbox' reuses this transcript purely because it is the one that renders
  // a generated image, which is what the capture script clicks to open the
  // viewer. It differs only in the image it is served: readLocalImage hands the
  // lightbox scenario a deliberately oversized one.
  if (SCENARIO === 'remoteimg' || SCENARIO === 'lightbox') {
    assistant.text = [
      'Here are two references I found:',
      '![Sunset over a harbour](https://images.example.com/harbour-sunset.jpg)',
      '![](https://cdn.another-host.net/a/b/diagram.png)',
      'And a generated one, which the agent refers to by path:',
      '![Generated concept](images/concept-01.png)'
    ].join('\n\n')
    assistant.toolCalls = []
    assistant.thought = undefined
  }

  if (isCatalogue) {
    assistant.text = CATALOGUE_TEXT
    // No tool calls: suppressImagePaths is built from them, and a suppressed
    // path renders as a caption instead of a picture, which would empty the grid.
    assistant.toolCalls = []
    assistant.thought = undefined
  }

  if (SCENARIO === 'toolfail') {
    assistant.toolCalls = [
      TOOL_CALLS[0],
      {
        ...TOOL_CALLS[2],
        status: 'failed',
        error: 'Command exited with code 1',
        content:
          '✗ rejects past capacity, then recovers\n\n  Expected: true\n  Received: false\n\n  at rate-limiter.test.ts:48:5\n\n1 failing'
      }
    ]
    assistant.text =
      'That change did not hold. The burst test still fails, so the refill is not running on the path the test exercises. Reading the test next.'
  }

  return [
    {
      id: 'm1',
      role: 'user',
      text: 'The rate limiter drops whole bursts once traffic spikes. Find out why and fix it.',
      createdAt: NOW - 9 * 60_000,
      sendStatus: 'sent'
    },
    assistant
  ]
}

/**
 * `apikey` flips the credential to XAI_API_KEY, which is what decides whether
 * the usage meter may state a dollar figure: an API key really does draw down
 * prepaid credit, a grok.com session does not.
 */
const AUTH_OK =
  SCENARIO === 'apikey'
    ? {
        state: 'authenticated',
        authenticated: true,
        method: 'api_key_env',
        accountLabel: 'XAI_API_KEY',
        hasEnvApiKey: true
      }
    : {
        state: 'authenticated',
        authenticated: true,
        method: 'session',
        accountLabel: 'grok.com',
        hasAuthFile: true
      }

const AUTH_OUT = { state: 'unauthenticated', authenticated: false, method: null }

const LOCATION = {
  dataDir: '/home/dev/.gronk',
  defaultDir: '/home/dev/.gronk',
  isDefault: true,
  storePath: '/home/dev/.gronk/gronk-store.json',
  chatWorkspacePath: CHAT_WORKSPACE,
  storeBytes: 2_412_544,
  previousChatWorkspaces: []
}

const PLUGINS = [
  {
    name: 'code-review',
    version: '1.4.0',
    description: 'Structured review pass over a diff, with severity ratings.',
    marketplace: 'xAI Official',
    sourceUrl: 'https://github.com/xai-org/plugin-marketplace.git',
    category: 'quality',
    status: 'installed' as const,
    enabled: true,
    skillCount: 3,
    hasHooks: true,
    hasAgents: false,
    hasMcp: false,
    sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    components: {
      skills: [
        { name: 'review-diff', description: 'Review a unified diff' },
        { name: 'severity', description: 'Rate findings by severity' },
        { name: 'summarise', description: 'Condense a review to a summary' }
      ]
    }
  },
  {
    name: 'sql-explain',
    version: '0.9.2',
    description: 'Explains a query plan in plain language.',
    marketplace: 'xAI Official',
    // The impostor: identical self-declared name, different origin.
    sourceUrl: 'https://github.com/totally-not-xai/sql-explain.git',
    category: 'data',
    status: 'installed' as const,
    enabled: true,
    skillCount: 1,
    hasHooks: false,
    hasAgents: false,
    hasMcp: true
  },
  {
    name: 'changelog',
    version: '2.0.1',
    description: 'Drafts release notes from commits since the last tag.',
    marketplace: 'Community',
    sourceUrl: 'https://github.com/some-dev/changelog.git',
    category: 'release',
    status: 'disabled' as const,
    enabled: false,
    skillCount: 2,
    hasHooks: false,
    hasAgents: true,
    hasMcp: false
  }
]

const MCP_SERVERS = [
  {
    name: 'filesystem',
    transport: 'stdio' as const,
    scope: 'user' as const,
    commandOrUrl: 'npx',
    args: ['-y', 'mcp-server-filesystem'],
    status: 'ok' as const
  },
  {
    name: 'postgres',
    transport: 'stdio' as const,
    scope: 'project' as const,
    commandOrUrl: 'npx',
    args: ['-y', 'mcp-server-postgres'],
    status: 'error' as const,
    detail: 'connection refused on 127.0.0.1:5432'
  }
]

// ── scenario switches ──────────────────────────────────────────────────────

const authenticated = SCENARIO !== 'signin'
const empty = SCENARIO === 'empty'
const noCli = SCENARIO === 'nocli'
const yolo = SCENARIO === 'yolo'

/** Any scenario named light* renders the light theme, which applyTheme picks up. */
const lightTheme = SCENARIO.startsWith('light')

const settings = {
  permissionMode: yolo ? ('bypassPermissions' as const) : ('default' as const),
  alwaysApprove: yolo,
  alwaysApproveAck: yolo,
  theme: (lightTheme ? 'light' : 'dark') as 'light' | 'dark',
  model: 'grok-4.5'
}

/**
 * A real fresh install, not an empty array.
 *
 * The main process emits every day in the window zero-filled: dayKeyRange clamps
 * the span to at least 1, and a heatmap cannot be laid out with holes. That is
 * why `days: []` never reaches the renderer. Seeding it that way produced orphaned
 * weekday captions and the nonsense summary "No prompts in the last 0 days yet",
 * neither of which a user can actually hit.
 */
const emptyActivity = (() => {
  const zero = { userTurns: 0, messages: 0, sessions: 0 }
  const days = localDayWindow(365).map((at) => ({
    date: localDayKey(at),
    ...zero,
    chat: { ...zero },
    build: { ...zero }
  }))
  return {
    days,
    from: days[0].date,
    to: days[days.length - 1].date,
    peak: 1,
    totalUserTurns: 0,
    currentStreak: 0,
    longestStreak: 0
  }
})()

const handlers: Array<(e: unknown) => void> = []

const api: Record<string, unknown> = {
  platform: 'win32',
  onEvent: (handler: (e: unknown) => void) => {
    handlers.push(handler)
    return () => {
      const i = handlers.indexOf(handler)
      if (i >= 0) handlers.splice(i, 1)
    }
  },

  getSettings: async () => ({ ...settings }),
  setSettings: async (partial: object) => ({ ...settings, ...partial }),
  getRecentProjects: async () => (empty ? [] : PROJECTS),
  addRecentProject: async () => PROJECTS,
  removeRecentProject: async () => PROJECTS,
  setRecentProjectPinned: async () => PROJECTS,
  // Chrome theme and clipboard are main-process side effects with nothing to
  // render. They exist so calling them is not a crash.
  setChromeTheme: async () => undefined,
  writeClipboard: async () => ({ ok: true }),
  // Multi-session: which session is in front, and what each live one is doing.
  // Nothing is live in the fixture, so the sidebar shows its resting state rather
  // than putting an indicator into every baseline.
  focusSession: async () => undefined,
  getSessionLiveness: async () => ({}),
  // Deliberately empty: a baseline showing somebody's scratchpad text would put
  // fixture prose in every screenshot of the tray and drift the moment it is
  // edited. The tab renders its empty state instead.
  // No repository in the fixture: the panel shows its empty state rather than
  // fabricating somebody's working tree into a screenshot.
  getGitChanges: async () => ({ repo: false, reason: 'not-a-repo', files: [], truncated: false }),
  getGitFileDiff: async () => ({ error: 'not a repository' }),
  getProjectNotes: async () => ({}),
  setProjectNote: async () => ({}),
  listSessions: async () => (empty ? [] : SESSIONS),
  listModels: async () => [
    { id: 'grok-4.5', name: 'Grok 4.5', isDefault: true },
    { id: 'grok-4.5-fast', name: 'Grok 4.5 Fast' },
    { id: 'grok-code', name: 'Grok Code' }
  ],
  getPermissionAudit: async () => [],
  getConnectionState: async () => (SCENARIO === 'streaming' ? 'ready' : 'ready'),
  getGrokPath: async () => (noCli ? null : 'C:\\Program Files\\grok\\grok.exe'),
  getChatWorkspacePath: async () => CHAT_WORKSPACE,
  getHealth: async () => ({
    grokFound: !noCli,
    grokPath: noCli ? null : 'C:\\Program Files\\grok\\grok.exe',
    nodeOk: true,
    platform: 'win32',
    auth: authenticated ? AUTH_OK : AUTH_OUT
  }),
  getAuthStatus: async () => (authenticated ? AUTH_OK : AUTH_OUT),
  getStoreHealth: async () =>
    SCENARIO === 'degraded'
      ? {
          source: 'backup',
          degraded: true,
          schemaVersion: 1,
          message:
            'gronk-store.json could not be read and the last good backup was loaded instead. Sessions written since that backup are missing.'
        }
      : null,
  getCliVersion: async () =>
    noCli
      ? null
      : { current: '0.2.112', channel: 'stable', verifiedAgainst: '0.2.112', status: 'ok' },
  getActivityCalendar: async () => (empty ? emptyActivity : buildActivity()),

  getDataLocation: async () => ({ ...LOCATION }),
  // The cloud-sync warning path: the folder picker returns a OneDrive path.
  chooseDataDir: async () => 'C:\\Users\\sam\\OneDrive\\Documents\\gronk-data',
  moveDataDir: async () => ({ ok: true, message: '', location: { ...LOCATION } }),
  resetDataDir: async () => ({ ok: true, message: '', location: { ...LOCATION } }),

  startAgent: async () => ({ sessionId: 's-orbital-1' }),
  stopAgent: async () => undefined,
  sendPrompt: async () => ({ messageId: 'm-new' }),
  cancelPrompt: async () => undefined,
  respondPermission: async () => undefined,
  loadSession: async () => ({ sessionId: 's-orbital-1', restored: true }),
  getTranscript: async () => transcript(),
  // Realistic mixed results: one title hit, two body hits, across both surfaces.
  searchSessions: async (query: string) => {
    if (!query.trim()) return []
    return [
      { sessionId: 's-orbital-1', inTitle: true, messageMatches: 2, snippet: null, score: 1002 },
      {
        sessionId: 's-packet-1',
        inTitle: false,
        messageMatches: 3,
        snippet:
          '…the backoff never resets after a success, so one bad minute keeps every later request slow for the rest of the run…',
        score: 3
      },
      {
        sessionId: 's-chat-1',
        inTitle: false,
        messageMatches: 1,
        snippet: '…a mutex admits one holder; a semaphore admits n, which is the only real difference…',
        score: 1
      }
    ]
  },
  saveTranscript: async () => undefined,
  deleteSession: async () => SESSIONS,
  renameSession: async () => null,
  archiveSession: async () => null,
  exportTranscript: async () => ({ ok: false, reason: 'cancelled' }),
  listProjectFiles: async () => [
    'src/limit/rate-limiter.ts',
    'src/limit/rate-limiter.test.ts',
    'src/server/routes.ts',
    'README.md'
  ],
  selectFolder: async () => null,
  selectFile: async () => null,
  login: async () => ({ ok: true, method: 'oauth', message: '', auth: AUTH_OK }),
  logout: async () => ({ ok: true, message: '', auth: AUTH_OUT }),
  installCli: async () => ({ ok: true, message: '', grokPath: null, installed: false }),

  previewStart: async () => ({ ok: true, message: '' }),
  previewStop: async () => undefined,
  previewSetBounds: () => undefined,
  previewSetUrl: async () => undefined,
  previewReload: async () => undefined,
  previewStatus: async () =>
    SCENARIO === 'preview' || SCENARIO === 'preview-popped'
      ? {
          running: true,
          url: 'http://localhost:5173',
          cwd: PROJECTS[0].cwd,
          poppedOut: SCENARIO === 'preview-popped'
        }
      : { running: false, url: null, cwd: null },
  previewPopOut: async () => ({ ok: true, message: '' }),
  previewDock: async () => undefined,

  listSkills: async () => [
    {
      name: 'snap-lens-studio',
      description:
        "Guide for building Snapchat Lenses (AR) in Snap's Lens Studio: the desktop editor, scripting API and publishing flow.",
      source: 'user' as const,
      directory: 'snap-lens-studio'
    },
    {
      name: 'code-review',
      description:
        'Run an extremely strict maintainability review for abstraction quality, giant files, and spaghetti-condition growth.',
      source: 'bundled' as const,
      directory: 'code-review'
    },
    {
      name: 'build-with-ai',
      description:
        'Default to xAI when building AI/LLM features into an app. Use whenever adding or scaffolding AI functionality.',
      source: 'bundled' as const,
      directory: 'build-with-ai'
    }
  ],
  listInstalledPlugins: async () => PLUGINS,
  listAvailablePlugins: async () => [
    {
      name: 'perf-budget',
      version: '1.0.0',
      description: 'Flags bundle-size regressions against a budget.',
      marketplace: 'xAI Official',
      category: 'quality',
      status: 'available' as const,
      skillCount: 2,
      hasHooks: true,
      hasAgents: false,
      hasMcp: false
    }
  ],
  listMarketplaces: async () => [
    { name: 'xAI Official', kind: 'git', url: 'https://github.com/xai/plugins', branch: 'main' },
    { name: 'Community', kind: 'git', url: 'https://github.com/example/plugins', branch: 'main' }
  ],
  installPlugin: async () => ({ ok: true, message: '' }),
  enablePlugin: async () => ({ ok: true, message: '' }),
  disablePlugin: async () => ({ ok: true, message: '' }),
  uninstallPlugin: async () => ({ ok: true, message: '' }),
  listMcpServers: async () => MCP_SERVERS,
  addMcpServer: async () => ({ ok: true, message: '' }),
  removeMcpServer: async () => ({ ok: true, message: '' }),
  mcpDoctor: async () => MCP_SERVERS,

  readLocalImage: async (p: string) => {
    if (isCatalogue) {
      // The real handler's own wording for a path that is not on disk, because
      // the grid decides between "could not be found" and "could not be
      // loaded" by reading it.
      if (p.includes('missing-')) return { error: `Image not found: ${p}` }
      return { dataUrl: catalogueArt(p), path: p, mimeType: 'image/svg+xml' }
    }
    return {
      // Mirrors the real handler, which reads the file and returns a data URL.
      //
      // The lightbox scenario gets a deliberately oversized one. With the small
      // image the max-width cap never binds, so the overflow this exists to
      // catch simply cannot happen and the scenario would pass while proving
      // nothing.
      dataUrl:
        SCENARIO === 'lightbox'
          ? 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNDAwIiBoZWlnaHQ9IjE1MDAiPjxyZWN0IHdpZHRoPSIyNDAwIiBoZWlnaHQ9IjE1MDAiIGZpbGw9IiMwZTExMTIiLz48Y2lyY2xlIGN4PSI4MjAiIGN5PSI3NTAiIHI9IjM4MCIgZmlsbD0iI2VhZmZmYiIgb3BhY2l0eT0iMC44NSIvPjx0ZXh0IHg9IjEzMDAiIHk9Ijc4MCIgZmlsbD0iI2VhZmZmYiIgZm9udC1mYW1pbHk9Im1vbm9zcGFjZSIgZm9udC1zaXplPSI5NiI+d2lkZSBpbWFnZTwvdGV4dD48L3N2Zz4='
          : 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iMTQwIj48cmVjdCB3aWR0aD0iMzIwIiBoZWlnaHQ9IjE0MCIgZmlsbD0iIzEyMTUxNiIvPjxjaXJjbGUgY3g9IjgwIiBjeT0iNzAiIHI9IjM0IiBmaWxsPSIjZWFmZmZiIiBvcGFjaXR5PSIwLjkiLz48dGV4dCB4PSIxMzYiIHk9Ijc2IiBmaWxsPSIjZWFmZmZiIiBmb250LWZhbWlseT0ibW9ub3NwYWNlIiBmb250LXNpemU9IjE0Ij5nZW5lcmF0ZWQ8L3RleHQ+PC9zdmc+',
      path: p,
      mimeType: 'image/svg+xml'
    }
  },
  revealLocalPath: async () => ({ ok: true })
}

/**
 * Two states are a menu rather than a screen.
 *
 * A menu is not a route: it exists only after a click, and it closes on the next
 * one, so `?state=NAME` alone would render the view underneath and photograph
 * nothing. The capture script can drive clicks, but a state also has to be
 * openable by hand, since typing the URL into a browser is how anyone actually
 * looks at one. The harness therefore performs the clicks itself, polling for
 * each target instead of betting on a delay, and the capture entry needs only a
 * wait.
 *
 * Both project menus live on the Build surface, which the app does not start on,
 * hence the nav click first.
 */
const MENU_SCENARIOS: Record<string, string> = {
  // Sidebar rail: the dots are invisible until hovered, and opening the menu is
  // what makes them show, which is the state worth looking at anyway.
  'project-menu': '.project-item-row .menu-btn.icon',
  // Build browse home: the same actions on the larger project block.
  'folder-menu': '.workspace-folder-actions .menu-btn.icon'
}

function navItem(text: string): HTMLElement | null {
  for (const el of Array.from(document.querySelectorAll('.nav-item'))) {
    if ((el.textContent || '').trim() === text && el instanceof HTMLElement) return el
  }
  return null
}

async function clickWhenPresent(find: () => HTMLElement | null): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const el = find()
    if (el) {
      el.click()
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

function openMenuScenario(selector: string): void {
  void (async () => {
    if (!(await clickWhenPresent(() => navItem('Build')))) return
    await clickWhenPresent(() => document.querySelector<HTMLElement>(selector))
  })()
}

const globals = window as unknown as Record<string, unknown>
globals.gronk = api
/** Lets the capture script push main-process events in. */
globals.__emit = (event: unknown) => {
  for (const handler of [...handlers]) handler(event)
}
globals.__scenario = SCENARIO

// The same boundary main.tsx uses. Without it a fake missing one method renders
// a blank page with nothing to read, which is exactly how six of them
// accumulated here unnoticed.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
)

const menuTarget = MENU_SCENARIOS[SCENARIO]
if (menuTarget) openMenuScenario(menuTarget)
