import { spawn } from 'node:child_process'
import { getSettings } from './store'
import { resolveGrokBinary } from './acp/client'
import type { ModelInfo } from '../../shared/types'

/**
 * List models via `grok models` (no extra npm packages).
 * Falls back to a known-safe default if the CLI is unavailable.
 */
export async function listModels(): Promise<ModelInfo[]> {
  const settings = getSettings()
  const binary = resolveGrokBinary(settings.grokBinary)
  if (!binary) {
    return [{ id: 'grok-4.5', name: 'Grok 4.5', isDefault: true }]
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

function defaultModels(): ModelInfo[] {
  return [{ id: 'grok-4.5', name: 'Grok 4.5', isDefault: true }]
}

function parseModelsText(text: string): ModelInfo[] | null {
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
