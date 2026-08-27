import type { ToolCallInfo, ToolCallStatus } from '../../shared/types'
import { flattenToolContent } from './image-refs'
import { parseRawInput, pickString } from './tool-payload'

/**
 * Agent / task activity derived only from ACP tool_call streams.
 * No LLM summarization: labels come from tool names + rawInput fields Grok sends.
 */

export type AgentUnitKind =
  | 'subagent'
  | 'background'
  | 'workflow'
  | 'monitor'
  | 'scheduler'
  | 'other'

export interface AgentUnit {
  /** Stable key (toolCallId) */
  id: string
  /**
   * The work this call is about, when the agent named one.
   *
   * The merge key, and the reason the list is readable. A background task is
   * spawned once and then polled — each poll is its own tool call, so keying on
   * the call id turned 60 status checks of two tasks into 60 separate "agents".
   * Keyed on the task, a poll updates the row it is about.
   */
  taskId?: string
  kind: AgentUnitKind
  /** Human label from Grok fields only (description, subagent_type, etc.) */
  label: string
  /** Secondary line: type / isolation / task id if present */
  detail?: string
  status: ToolCallStatus
  /** Raw tool title/kind for tooltip */
  source: string
}

/**
 * What a call may be classified by: the agent's own tool name, plus the coarse kind.
 *
 * NEVER the title. The title is a rendered description — `Read \`C:/…/workflows.md\``,
 * a whole PowerShell command — so matching it counted every file read whose path
 * contained "workflow" as a running workflow, and every backgrounded shell command as
 * an agent. On one real session that turned 1 subagent into 68 "agents", which is a
 * count nobody can act on.
 */
function toolBlob(tool: ToolCallInfo): string {
  return `${tool.name || ''} ${tool.kind || ''}`.toLowerCase()
}

/** True if this tool call is about a child agent, background task, workflow, etc. */
export function isAgentActivityTool(tool: ToolCallInfo): boolean {
  const b = toolBlob(tool)
  if (
    /spawn_subagent|subagent|kill_command_or_subagent|get_command_or_subagent|wait_command|workflow|scheduler|monitor/.test(
      b
    )
  ) {
    return true
  }
  const input = parseRawInput(tool.rawInput)
  if (input?.background === true) return true
  if (typeof input?.subagent_type === 'string') return true
  if (typeof input?.task_id === 'string' || Array.isArray(input?.task_ids)) return true
  return false
}

function classify(tool: ToolCallInfo, input: Record<string, unknown> | null): AgentUnitKind {
  const b = toolBlob(tool)
  if (/workflow/.test(b)) return 'workflow'
  if (/monitor/.test(b)) return 'monitor'
  if (/scheduler|scheduler_create|scheduler_delete/.test(b)) return 'scheduler'
  if (/spawn_subagent|subagent/.test(b) || typeof input?.subagent_type === 'string') {
    return 'subagent'
  }
  if (
    input?.background === true ||
    /background|run_terminal|get_command|kill_command|wait_command/.test(b)
  ) {
    return 'background'
  }
  return 'other'
}

function extractTaskId(tool: ToolCallInfo, input: Record<string, unknown> | null): string | undefined {
  const fromIn =
    pickString(input, ['task_id', 'taskId', 'subagent_id', 'subagentId', 'id']) ||
    (Array.isArray(input?.task_ids) && typeof input!.task_ids[0] === 'string'
      ? String(input!.task_ids[0])
      : undefined)
  if (fromIn) return fromIn

  for (const chunk of flattenToolContent(tool.content)) {
    try {
      const o = JSON.parse(chunk) as Record<string, unknown>
      const id = pickString(o, ['task_id', 'taskId', 'subagent_id', 'subagentId', 'id'])
      if (id) return id
    } catch {
      const m = chunk.match(
        /(?:task_id|subagent_id|task id)\s*[:=]\s*["']?([a-zA-Z0-9._:-]+)/i
      )
      if (m) return m[1]
    }
  }
  return undefined
}

/** Map one tool call → agent unit if applicable. */
export function toolToAgentUnit(tool: ToolCallInfo): AgentUnit | null {
  if (!isAgentActivityTool(tool)) return null
  const input = parseRawInput(tool.rawInput)
  const kind = classify(tool, input)

  const subType = pickString(input, ['subagent_type', 'subagentType', 'agent_type', 'type'])
  const description = pickString(input, ['description', 'name', 'title'])
  const prompt = pickString(input, ['prompt'])
  const isolation = pickString(input, ['isolation'])
  const command = pickString(input, ['command', 'cmd'])
  const taskId = extractTaskId(tool, input)

  let label =
    description ||
    (kind === 'subagent' && subType ? `Subagent · ${subType}` : undefined) ||
    (kind === 'workflow' ? 'Workflow' : undefined) ||
    (kind === 'monitor' ? 'Monitor' : undefined) ||
    (kind === 'background' && command
      ? command.length > 48
        ? command.slice(0, 45) + '…'
        : command
      : undefined) ||
    tool.title ||
    tool.kind ||
    'Agent task'

  // Prefer short description over raw tool name "Tool"
  if (label === 'Tool' || label === 'tool') {
    label =
      (kind === 'subagent' ? `Subagent${subType ? ` · ${subType}` : ''}` : null) ||
      (kind === 'background' ? 'Background task' : null) ||
      kind
  }

  const detailParts: string[] = []
  if (subType && !label.toLowerCase().includes(subType.toLowerCase())) {
    detailParts.push(subType)
  }
  if (isolation && isolation !== 'none') detailParts.push(`isolation:${isolation}`)
  if (taskId) detailParts.push(taskId.length > 16 ? taskId.slice(0, 14) + '…' : taskId)
  if (prompt && kind === 'subagent') {
    const p = prompt.replace(/\s+/g, ' ')
    detailParts.push(p.length > 60 ? p.slice(0, 57) + '…' : p)
  }
  if (command && kind === 'background' && description) {
    detailParts.push(command.length > 40 ? command.slice(0, 37) + '…' : command)
  }

  return {
    id: tool.toolCallId,
    taskId,
    kind,
    label,
    detail: detailParts.length ? detailParts.join(' · ') : undefined,
    status: tool.status,
    source: tool.title || tool.kind || tool.toolCallId
  }
}

export function extractAgentUnits(tools: ToolCallInfo[]): AgentUnit[] {
  const out: AgentUnit[] = []
  for (const t of tools) {
    const u = toolToAgentUnit(t)
    if (u) out.push(u)
  }
  return out
}

/** Aggregate live units across messages (current turn + recent). */
export function collectAgentUnitsFromMessages(
  messages: Array<{ toolCalls?: ToolCallInfo[] }>,
  opts?: { maxMessages?: number }
): AgentUnit[] {
  const max = opts?.maxMessages ?? 12
  const slice = messages.slice(-max)
  const byId = new Map<string, AgentUnit>()
  for (const m of slice) {
    for (const u of extractAgentUnits(m.toolCalls || [])) {
      // Keyed on the task when there is one: a spawn and every later poll of it are
      // one unit of work, and only the status is news.
      const key = u.taskId || u.id
      const prev = byId.get(key)
      byId.set(key, prev ? mergeUnit(prev, u) : u)
    }
  }
  return [...byId.values()]
}

/**
 * Fold a later observation into the unit it is about.
 *
 * Status is always the newer one — that is what a poll is for. The label is not:
 * the spawn call carries the description and a poll carries the polling tool's own
 * name, so taking the newer label renames "Diff Claude vs Grok skill" to something
 * like "get_command". The more specific label wins regardless of order.
 */
function mergeUnit(prev: AgentUnit, next: AgentUnit): AgentUnit {
  const prevSpecific = prev.kind !== 'other' && !!prev.detail
  return {
    ...prev,
    status: next.status,
    kind: prev.kind === 'other' ? next.kind : prev.kind,
    label: prevSpecific || next.kind === 'other' ? prev.label : next.label,
    detail: prev.detail || next.detail
  }
}

export function agentActivitySummary(units: AgentUnit[]): {
  live: number
  done: number
  failed: number
  total: number
} {
  let live = 0
  let done = 0
  let failed = 0
  for (const u of units) {
    if (u.status === 'in_progress' || u.status === 'pending') live++
    else if (u.status === 'failed' || u.status === 'cancelled') failed++
    else if (u.status === 'completed') done++
  }
  return { live, done, failed, total: units.length }
}

/**
 * Live and failed first so a long finished list cannot bury active work in the
 * composer strip.
 */
export function orderUnitsForDisplay(units: AgentUnit[]): AgentUnit[] {
  const rank = (u: AgentUnit): number => {
    if (u.status === 'in_progress' || u.status === 'pending') return 0
    if (u.status === 'failed') return 1
    if (u.status === 'cancelled') return 2
    return 3
  }
  return [...units].sort((a, b) => rank(a) - rank(b))
}
