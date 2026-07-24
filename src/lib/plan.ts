import type { PlanItem } from '../../shared/types'

/** Normalize heterogeneous ACP plan payloads into a flat checklist. */
export function parsePlan(plan: unknown): PlanItem[] {
  if (!plan) return []

  const root = plan as Record<string, unknown>
  const candidates =
    (Array.isArray(root.entries) && root.entries) ||
    (Array.isArray(root.items) && root.items) ||
    (Array.isArray(root.plan) && root.plan) ||
    (Array.isArray(root) && root) ||
    (Array.isArray((root.content as { entries?: unknown })?.entries) &&
      (root.content as { entries: unknown[] }).entries) ||
    []

  return (candidates as unknown[])
    .map((raw, i) => {
      if (typeof raw === 'string') {
        return { id: `plan-${i}`, content: raw, status: 'pending' as const }
      }
      const e = (raw ?? {}) as Record<string, unknown>
      const content =
        (e.content as string) ||
        (e.text as string) ||
        (e.title as string) ||
        (e.description as string) ||
        JSON.stringify(e).slice(0, 120)
      const status = String(e.status || e.state || 'pending').toLowerCase()
      return {
        id: String(e.id || e.entryId || `plan-${i}`),
        content,
        status,
        priority: typeof e.priority === 'number' ? e.priority : undefined
      }
    })
    .filter((e) => e.content)
}
