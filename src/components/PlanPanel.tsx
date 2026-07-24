import type { ActivePlan } from '../../shared/types'

interface Props {
  plan: ActivePlan | null
  collapsed: boolean
  onToggle: () => void
}

function statusClass(status: string): string {
  const s = status.toLowerCase()
  if (s.includes('complete') || s === 'done') return 'done'
  if (s.includes('progress') || s === 'running' || s === 'active') return 'run'
  if (s.includes('fail') || s.includes('error')) return 'fail'
  return 'pending'
}

export function PlanPanel({ plan, collapsed, onToggle }: Props) {
  if (!plan || plan.entries.length === 0) return null

  const done = plan.entries.filter((e) => statusClass(e.status) === 'done').length
  const total = plan.entries.length

  return (
    <div className={`plan-panel ${collapsed ? 'collapsed' : ''}`}>
      <button type="button" className="plan-head" onClick={onToggle}>
        <span className="plan-label">Plan</span>
        <span className="plan-progress">
          {done}/{total}
        </span>
        <span className="plan-chevron">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed ? (
        <ul className="plan-list">
          {plan.entries.map((e) => (
            <li key={e.id} className={`plan-item ${statusClass(e.status)}`}>
              <span className="plan-dot" aria-hidden />
              <span className="plan-text">{e.content}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
