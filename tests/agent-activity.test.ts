import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agentActivitySummary,
  collectAgentUnitsFromMessages,
  isAgentActivityTool,
  orderUnitsForDisplay,
  type AgentUnit
} from '../src/lib/agent-activity'
import type { ToolCallInfo } from '../shared/types'

function unit(
  id: string,
  status: AgentUnit['status'],
  kind: AgentUnit['kind'] = 'subagent'
): AgentUnit {
  return { id, kind, label: id, status, source: id }
}

test('orderUnitsForDisplay puts live work before finished', () => {
  const ordered = orderUnitsForDisplay([
    unit('done', 'completed'),
    unit('run', 'in_progress'),
    unit('fail', 'failed'),
    unit('wait', 'pending')
  ])
  assert.deepEqual(
    ordered.map((u) => u.id),
    ['run', 'wait', 'fail', 'done']
  )
})

test('agentActivitySummary counts live done and failed', () => {
  const s = agentActivitySummary([
    unit('a', 'in_progress'),
    unit('b', 'pending'),
    unit('c', 'completed'),
    unit('d', 'failed'),
    unit('e', 'cancelled')
  ])
  assert.equal(s.live, 2)
  assert.equal(s.done, 1)
  assert.equal(s.failed, 2)
  assert.equal(s.total, 5)
})

// ── One row per unit of work ────────────────────────────────────────

const call = (over: Partial<ToolCallInfo>): ToolCallInfo =>
  ({ toolCallId: 'c1', title: 'Tool', status: 'completed', ...over }) as ToolCallInfo

test('POLLING A TASK UPDATES ITS ROW INSTEAD OF ADDING ONE', () => {
  // A background task is spawned once and then polled, each poll its own tool call.
  // Keyed on the call id, sixty checks of two tasks read as sixty agents — measured
  // on a real transcript, where 1 subagent and a handful of tasks showed as 68.
  const messages = [
    {
      toolCalls: [
        call({
          toolCallId: 'spawn-1',
          name: 'spawn_subagent',
          rawInput: { task_id: 'task-abc', description: 'Diff Claude vs Grok skill' },
          status: 'in_progress'
        })
      ]
    },
    {
      toolCalls: [
        call({ toolCallId: 'poll-1', name: 'get_command_or_subagent', rawInput: { task_ids: ['task-abc'] } }),
        call({ toolCallId: 'poll-2', name: 'get_command_or_subagent', rawInput: { task_ids: ['task-abc'] } })
      ]
    }
  ]

  const units = collectAgentUnitsFromMessages(messages, { maxMessages: 20 })
  assert.equal(units.length, 1, 'each poll created another agent')
  // The status is the news a poll carries.
  assert.equal(units[0].status, 'completed')
  // The label is not: the spawn call knows what the work is, the poll knows only
  // its own tool name.
  assert.match(units[0].label, /Diff Claude vs Grok skill/)
})

test('TWO REAL TASKS STAY TWO ROWS', () => {
  // The merge must not collapse distinct work — that would hide exactly what the
  // panel is for.
  const messages = [
    {
      toolCalls: [
        call({ toolCallId: 'a', name: 'spawn_subagent', rawInput: { task_id: 't1', description: 'First' } }),
        call({ toolCallId: 'b', name: 'spawn_subagent', rawInput: { task_id: 't2', description: 'Second' } })
      ]
    }
  ]
  assert.equal(collectAgentUnitsFromMessages(messages, { maxMessages: 20 }).length, 2)
})

test('A FILE WHOSE PATH SAYS WORKFLOW IS NOT A WORKFLOW', () => {
  // The title is a rendered description carrying paths and whole command lines, so
  // matching it made every read of a file under a "workflows" folder an agent.
  const read = call({
    toolCallId: 'r1',
    name: 'read_file',
    kind: 'read',
    title: 'Read `C:/Users/x/.grok/skills/snap/workflows.md`'
  })
  assert.equal(isAgentActivityTool(read), false)

  const shell = call({
    toolCallId: 's1',
    name: 'shell',
    kind: 'execute',
    title: 'Execute `python monitor_workflow.py`'
  })
  assert.equal(isAgentActivityTool(shell), false, 'a command mentioning workflow is not an agent')

  // The real thing still registers, by name and by input.
  assert.equal(isAgentActivityTool(call({ name: 'spawn_subagent' })), true)
  assert.equal(
    isAgentActivityTool(call({ name: 'shell', rawInput: { background: true } })),
    true
  )
})
