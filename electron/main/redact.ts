/**
 * Shared secret redaction for logs, audit previews, and tool payloads.
 * Never reverse this — drop secrets rather than store them.
 *
 * Do NOT run over user-visible message text/thought before persisting transcripts
 * (FIX-R1) — that corrupts session restore. Transcripts are local user data.
 */

/**
 * The `(?:Bearer|Basic|...)\s+` group matters: without it `Authorization: Bearer <token>`
 * matched only up to the scheme word, so `\S+` consumed "Bearer" and the token itself
 * survived redaction (found by tests/redact.test.ts). Same for `Basic`/`Token`/`Digest`.
 */
const AUTH_SCHEME = '(?:Bearer|Basic|Token|Digest|JWT)'

const SECRET_PATTERNS: RegExp[] = [
  /\b(xai|sk|gsk|ghp|gho|ghu|ghs|ghr)[-_][A-Za-z0-9._-]{8,}\b/gi,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  new RegExp(
    `\\b(access_token|refresh_token|api[_-]?key|authorization|password|secret|bearer)\\s*[:=]\\s*(?:${AUTH_SCHEME}\\s+)?\\S+`,
    'gi'
  ),
  /\bBearer\s+[A-Za-z0-9._\-+=/]{12,}\b/gi,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
]

export function redactSecrets(text: string): string {
  if (!text) return text
  let out = text
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match) => {
      if (match.includes('@') && !/token|key|secret|bearer|password/i.test(match)) {
        return '[redacted-email]'
      }
      if (/^eyJ/i.test(match)) return '[redacted-jwt]'
      if (/=/.test(match) || /:/.test(match)) {
        // Replace the ENTIRE tail, not just the first token — `Authorization: Bearer xyz`
        // must not leave `xyz` behind.
        return match.replace(/([:=]\s*)[\s\S]+$/, '$1[redacted]')
      }
      return '[redacted]'
    })
  }
  return out
}

/** Deep-redact string leaves in JSON-ish values before persist. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated-depth]'
  if (typeof value === 'string') {
    const red = redactSecrets(value)
    if (red.length > 4000) return red.slice(0, 4000) + '\n…[truncated]'
    return red
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((v) => redactValue(v, depth + 1))
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|authorization|api.?key/i.test(k)) {
        out[k] = '[redacted]'
      } else {
        out[k] = redactValue(v, depth + 1)
      }
    }
    return out
  }
  return value
}

export function redactPreview(value: unknown, max = 500): string | undefined {
  if (value === undefined) return undefined
  const raw =
    typeof value === 'string' ? value : (() => {
      try {
        return JSON.stringify(redactValue(value))
      } catch {
        return String(value)
      }
    })()
  return redactSecrets(raw).slice(0, max)
}
