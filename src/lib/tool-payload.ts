/** Shared parsing helpers for ACP tool rawInput / content objects. */

export function asObj(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return null
}

export function pickString(
  obj: Record<string, unknown> | null,
  keys: string[]
): string | undefined {
  if (!obj) return undefined
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

/** Parse tool rawInput that may already be an object or a JSON string. */
export function parseRawInput(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null
  if (typeof raw === 'string') {
    try {
      return asObj(JSON.parse(raw))
    } catch {
      return null
    }
  }
  return asObj(raw)
}
