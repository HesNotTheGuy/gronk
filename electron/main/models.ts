import { spawn } from 'node:child_process'
import { getSettings } from './store'
import { resolveGrokBinary } from './acp/client'
import { cachedProbe } from './cache'
import type { ModelInfo } from '../../shared/types'

/**
 * Model list via `grok models` (no extra npm packages), falling back to a
 * known-safe default when the CLI is unavailable.
 *
 * That command spawns a process and makes the same authenticated request to xAI
 * that the auth probe does, and it was called uncached on every app start. The
 * model list changes on the order of releases, not clicks, so it tolerates a far
 * longer TTL than sign-in state does.
 */
const MODELS_TTL_MS = 5 * 60_000

const modelsProbe = cachedProbe(() => probeModels(), { ttlMs: MODELS_TTL_MS })

export function listModels(): Promise<ModelInfo[]> {
  return modelsProbe.get()
}

/** Call when the configured grok binary changes — a different CLI may list different models. */
export function invalidateModelsCache(): void {
  modelsProbe.invalidate()
}

async function probeModels(): Promise<ModelInfo[]> {
  const settings = getSettings()
  const binary = resolveGrokBinary(settings.grokBinary)
  if (!binary) {
    return [{ id: 'grok-4.6', name: 'Grok 4.6', isDefault: true }]
  }

  return new Promise((resolve) => {
    const proc = spawn(binary, ['models'], {
      windowsHide: true,
      env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1' }
    })

    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      resolve(parseModelsText(out || err) || defaultModels())
    }, 8000)

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (c: string) => {
      out += c
    })
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (c: string) => {
      err += c
    })
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(defaultModels())
    })
    proc.on('close', () => {
      clearTimeout(timer)
      resolve(parseModelsText(out || err) || defaultModels())
    })
  })
}

/**
 * Shown when the CLI could not be asked. Display only — it is never sent as `-m`, because
 * an unset `settings.model` means Gronk passes no model at all and the CLI picks. So this
 * being one release behind makes a label wrong, not a session.
 */
export function defaultModels(): ModelInfo[] {
  return [{ id: 'grok-4.5', name: 'Grok 4.5', isDefault: true }]
}

export function parseModelsText(text: string): ModelInfo[] | null {
  if (!text.trim()) return null
  const models: ModelInfo[] = []
  const lines = text.split(/\r?\n/)

  // Default model line
  let defaultId: string | undefined
  for (const line of lines) {
    const dm = line.match(/Default model:\s*(\S+)/i)
    if (dm) defaultId = dm[1]
  }

  for (const line of lines) {
    // "  * grok-4.5 (default)" or "  - grok-build"
    const m = line.match(/^\s*[*•\-]\s+([a-zA-Z0-9._-]+)(?:\s+\(([^)]+)\))?/)
    if (m) {
      const id = m[1]
      const note = m[2] || ''
      models.push({
        id,
        name: id,
        description: note || undefined,
        isDefault: /default/i.test(note) || id === defaultId
      })
    }
  }

  // JSON fallback
  if (models.length === 0) {
    try {
      const json = JSON.parse(text) as { models?: Array<{ id?: string; modelId?: string; name?: string }> }
      const list = json.models || (Array.isArray(json) ? json : null)
      if (Array.isArray(list)) {
        for (const item of list as Array<Record<string, unknown>>) {
          const id = String(item.id || item.modelId || '')
          if (!id) continue
          models.push({
            id,
            name: String(item.name || id),
            isDefault: id === defaultId
          })
        }
      }
    } catch {
      /* not json */
    }
  }

  if (models.length === 0 && defaultId) {
    models.push({ id: defaultId, name: defaultId, isDefault: true })
  }

  return models.length ? models : null
}
