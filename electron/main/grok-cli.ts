/**
 * Shared Grok CLI spawn helper.
 *
 * Extracted from the module-private `runGrok` in auth.ts (Gotcha #1) so auth,
 * models, and plugins can share one code path.
 *
 * Security notes (do not weaken):
 * - Args are always passed as discrete argv (never `shell: true`), so shell
 *   injection is impossible. Callers must still reject values starting with '-'
 *   (option injection) — see `assertCliToken` in plugins.ts.
 * - Callers must redact stdout/stderr before sending it across IPC; the CLI can
 *   echo MCP `-e` env values and `-H` auth headers.
 */

import { spawn } from 'node:child_process'
import { resolveGrokBinary } from './acp/client'
import { getSettings } from './store'

export interface RunGrokOptions {
  timeoutMs?: number
  cwd?: string
}

export interface RunGrokResult {
  code: number | null
  stdout: string
  stderr: string
}

export const DEFAULT_CLI_TIMEOUT_MS = 15_000

/**
 * Run the Grok CLI and capture stdout/stderr. Never rejects: a missing binary,
 * spawn error, or timeout resolves with whatever was captured so callers can
 * surface a message instead of crashing the main process.
 */
export function runGrokCli(args: string[], options?: RunGrokOptions): Promise<RunGrokResult> {
  const binary = resolveGrokBinary(getSettings().grokBinary)
  if (!binary) {
    return Promise.resolve({
      code: 127,
      stdout: '',
      stderr: 'grok binary not found'
    })
  }

  return new Promise((resolve) => {
    let settled = false
    const done = (result: RunGrokResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const proc = spawn(binary, args, {
      windowsHide: true,
      cwd: options?.cwd,
      env: {
        ...process.env,
        GROK_DISABLE_AUTOUPDATER: '1'
      }
    })

    let stdout = ''
    let stderr = ''

    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      done({ code: proc.exitCode, stdout, stderr: stderr || 'timed out' })
    }, options?.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS)

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (c: string) => {
      stdout += c
    })
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (c: string) => {
      stderr += c
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      done({ code: 1, stdout, stderr: err.message })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr })
    })
  })
}

/**
 * Run the CLI and JSON.parse stdout. Returns null when the command failed to
 * produce parseable JSON (missing binary, timeout, text-only error output).
 */
export async function runGrokJson<T>(args: string[], options?: RunGrokOptions): Promise<T | null> {
  const { stdout } = await runGrokCli(args, options)
  const text = stdout.trim()
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
