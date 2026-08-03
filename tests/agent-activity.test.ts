import test from 'node:test'
import assert from 'node:assert/strict'
import {
  agentActivitySummary,
  orderUnitsForDisplay,
  type AgentUnit
} from '../src/lib/agent-activity'

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
