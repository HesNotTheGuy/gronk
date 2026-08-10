/**
 * Grok CLI authentication — per machine / per OS user.
 *
 * Goal: if you sign in here, that does not sign anyone else into their copy of
 * Gronk. Credentials are never packaged with the app.
 *
 * Security rules (do not weaken):
 * - Never read or forward tokens from ~/.grok/auth.json into the renderer.
 * - Never persist API keys in gronk-store.json (or the git repo).
 * - Prefer `grok login` (browser OAuth) so each install uses its own account.
 * - Detect credentials only via CLI probes + "file exists" / env presence flags.
 * - API key via XAI_API_KEY is supported as advanced fallback (env only).
 */

import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { resolveGrokBinary } from './acp/client'
import { decideAuth } from './auth-decision'
import { cachedProbe } from './cache'
import { grokHome } from './grok-home'
import { getSettings } from './store'
import { redactSecrets } from './redact'
import type { AuthStatus, LoginMethod } from '../../shared/types'

function authJsonPath(): string {
  return path.join(grokHome(), 'auth.json')
}

function hasAuthFile(): boolean {
  try {
    return fs.existsSync(authJsonPath()) && fs.statSync(authJsonPath()).isFile()
  } catch {
    return false
  }
}

function hasEnvApiKey(): boolean {
  const k = process.env.XAI_API_KEY
  return typeof k === 'string' && k.trim().length > 0
}

function resolveBinary(): string | null {
  return resolveGrokBinary(getSettings().grokBinary)
}

function runGrok(
  args: string[],
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv; onSpawn?: (proc: ChildProcess) => void }
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const binary = resolveBinary()
  if (!binary) {
    return Promise.resolve({
      code: 127,
      stdout: '',
      stderr: 'grok binary not found'
    })
  }

  return new Promise((resolve) => {
    const proc = spawn(binary, args, {
      windowsHide: true,
      env: {
        ...process.env,
        ...options?.env,
        GROK_DISABLE_AUTOUPDATER: '1'
      }
    })

    options?.onSpawn?.(proc)

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
      resolve({ code: proc.exitCode, stdout, stderr: stderr || 'timed out' })
    }, options?.timeoutMs ?? 15_000)

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
      resolve({ code: 1, stdout, stderr: err.message })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

export function sanitizeCliText(text: string): string {
  return redactSecrets(text).trim()
}

/** Never surface emails in accountLabel. */
export function parseLoginLabel(modelsOut: string): string | undefined {
  // e.g. "You are logged in with grok.com."
  // The trailing period is anchored to end-of-line. A lazy `(.+?)(?:\.|$)` stopped
  // at the FIRST dot, which both truncated "grok.com" to "grok" and — worse — turned
  // "first.last@corp.com" into "first", so the `@` guard below never fired and a
  // fragment of the user's email was surfaced as the account label.
  const m = modelsOut.match(/You are logged in with\s+(.+?)\.?\s*$/im)
  const m2 = modelsOut.match(/Logged in as\s+(.+?)\.?\s*$/im)
  let label = (m?.[1] || m2?.[1] || '').trim().replace(/\.$/, '')
  if (!label) return undefined
  if (/@/.test(label)) return 'Signed in'
  // Provider-style labels only
  if (/^[a-z0-9._-]+(\.[a-z]{2,})+$/i.test(label) || /^[a-z0-9._ -]+$/i.test(label)) {
    return label.slice(0, 64)
  }
  return 'Signed in'
}

export function looksUnauthenticated(stdout: string, stderr: string): boolean {
  const t = `${stdout}\n${stderr}`.toLowerCase()
  return /not logged in|not authenticated|please (run )?grok login|authentication required|unauthorized|invalid api key|no credentials|sign in to continue|login required|auth required|unauthori[sz]ed/.test(
    t
  )
}

/**
 * Every call spawns the CLI and makes an authenticated request to xAI. There are
 * ten call sites, several on hot paths — starting an agent, restoring a session,
 * the health panel — and app startup fires three concurrently inside one
 * Promise.all. Uncached, clicking through sessions meant one network round trip
 * per click. The TTL is short because sign-in state must not feel stale after the
 * user signs in or out; the login/logout paths invalidate it explicitly anyway.
 */
const AUTH_TTL_MS = 30_000

const authProbe = cachedProbe(() => probeAuthStatus(), { ttlMs: AUTH_TTL_MS })

export function getAuthStatus(): Promise<AuthStatus> {
  return authProbe.get()
}

/** Call after anything that changes sign-in state, so the next read is truthful. */
export function invalidateAuthCache(): void {
  authProbe.invalidate()
}

/** Does stdout look like the CLI actually printed a model list? */
export function looksLikeModelList(stdout: string): boolean {
  return /available models|default model/i.test(stdout)
}

/**
 * Probe auth without exposing secrets.
 *
 * This function's whole job is now observation: spawn the CLI, read the disk for
 * existence only, and hand the facts to `decideAuth`. It deliberately makes no
 * judgement of its own, because the judgement is the part that was wrong and the
 * part that has to stay tested.
 */
async function probeAuthStatus(): Promise<AuthStatus> {
  const binary = resolveBinary()
  if (!binary) {
    return {
      state: 'cli_missing',
      authenticated: false,
      method: 'none',
      message: 'Grok CLI not found. Install it, then sign in.'
    }
  }

  const filePresent = hasAuthFile()
  const envKey = hasEnvApiKey()

  const { code, stdout, stderr } = await runGrok(['models'], { timeoutMs: 12_000 })
  const combined = `${stdout}\n${stderr}`

  const decision = decideAuth({
    code,
    label: parseLoginLabel(stdout),
    modelsListed: looksLikeModelList(stdout),
    saysUnauthenticated: looksUnauthenticated(stdout, stderr),
    filePresent,
    envKey
  })

  // The one thing the pure decision cannot supply: the CLI's own words, for the
  // state where we genuinely do not know what happened. Redacted on the way
  // through, like every other subprocess output that crosses IPC.
  if (decision.state === 'unknown') {
    return {
      ...decision,
      message: sanitizeCliText(combined).slice(0, 280) || decision.message
    }
  }

  return decision
}

export interface LoginResult {
  ok: boolean
  method: LoginMethod
  message: string
  /** Device-code flow only: safe user-facing lines (URL/code), never tokens */
  deviceHint?: string
  auth: AuthStatus
}

/**
 * Start interactive login via the official CLI.
 * Browser OAuth opens the system browser; device flow prints a code.
 */
/**
 * The sign-in the CLI is running right now, so it can be called off.
 *
 * A browser login waits three minutes for a flow that may never come back — the
 * browser did not open, or it was closed. Without a way to end it, choosing the
 * other method would leave two `grok login` processes competing for the same
 * credential store.
 */
let activeLogin: ChildProcess | null = null

/**
 * End the sign-in in progress, if there is one.
 *
 * Answers whether there was one, because the caller uses that to decide whether
 * to report anything: cancelling nothing is not worth a message.
 */
export function cancelLogin(): boolean {
  const proc = activeLogin
  if (!proc || proc.exitCode !== null) return false
  activeLogin = null
  if (process.platform === 'win32' && proc.pid) {
    // The CLI spawns its own helper to hold the OAuth wait, and killing only the
    // parent leaves that helper on the credential store. /T walks the tree.
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    } catch {
      /* fall through to the direct kill below */
    }
  }
  try {
    proc.kill()
  } catch {
    /* already gone */
  }
  return true
}

export async function loginWithCli(method: LoginMethod = 'oauth'): Promise<LoginResult> {
  const binary = resolveBinary()
  if (!binary) {
    const auth = await getAuthStatus()
    return {
      ok: false,
      method,
      message: 'Grok CLI not found. Install the CLI before signing in.',
      auth
    }
  }

  const args =
    method === 'device' ? ['login', '--device-auth'] : ['login', '--oauth']

  // Device flow needs a longer poll window; browser OAuth waits for user.
  const timeoutMs = method === 'device' ? 180_000 : 180_000

  // A second sign-in replaces the first rather than racing it.
  cancelLogin()
  const { code, stdout, stderr } = await runGrok(args, {
    timeoutMs,
    onSpawn: (proc) => {
      activeLogin = proc
    }
  })
  activeLogin = null
  // The CLI just changed sign-in state on disk; the cached probe is now a lie.
  invalidateAuthCache()
  const safeOut = sanitizeCliText(`${stdout}\n${stderr}`)

  // After login CLI exits, re-probe
  const auth = await getAuthStatus()
  if (auth.authenticated) {
    return {
      ok: true,
      method,
      message: 'Signed in successfully. Each user must use their own account.',
      deviceHint: method === 'device' ? extractDeviceHint(safeOut) : undefined,
      auth
    }
  }

  return {
    ok: false,
    method,
    message:
      code === 0
        ? 'Login command finished but credentials are still missing. Try again or use device login.'
        : safeOut.slice(0, 400) ||
          'Sign-in failed or was cancelled. Try browser login again, or device code on this machine.',
    deviceHint: method === 'device' ? extractDeviceHint(safeOut) : undefined,
    auth
  }
}

export function extractDeviceHint(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const useful = lines.filter((l) =>
    /https?:\/\/|code|enter|device|verify|login/i.test(l)
  )
  if (!useful.length) return undefined
  return useful.slice(0, 12).join('\n').slice(0, 800)
}

export async function logoutWithCli(): Promise<{ ok: boolean; message: string; auth: AuthStatus }> {
  const binary = resolveBinary()
  if (!binary) {
    return {
      ok: false,
      message: 'Grok CLI not found.',
      auth: await getAuthStatus()
    }
  }

  const { code, stdout, stderr } = await runGrok(['logout'], { timeoutMs: 20_000 })
  // The CLI just changed sign-in state on disk; the cached probe is now a lie.
  invalidateAuthCache()
  const auth = await getAuthStatus()
  if (code === 0 || !auth.authenticated) {
    // Signing out clears the session, and an environment key is not a session.
    // Saying so is the difference between a button that looks broken and one
    // that worked: before the probe was fixed the state flipped straight back to
    // "Signed in" and there was nothing to read that explained why.
    if (auth.authenticated && auth.method === 'api_key_env') {
      return {
        ok: true,
        message:
          'Session cleared, but XAI_API_KEY is still set in the environment and the CLI accepts it, so this machine is still authenticated. Unset XAI_API_KEY to sign out completely.',
        auth
      }
    }
    return {
      ok: true,
      message:
        'Signed out. Cached CLI credentials cleared. Gronk does not keep your tokens.',
      auth
    }
  }
  return {
    ok: false,
    message: sanitizeCliText(`${stdout}\n${stderr}`).slice(0, 400) || 'Logout may have failed.',
    auth
  }
}

/** Hard gate for agent start — never start an agent without credentials. */
export async function assertAuthenticated(): Promise<AuthStatus> {
  const auth = await getAuthStatus()
  if (!auth.authenticated) {
    const err = new Error(
      auth.message ||
        'Sign in required. Open Settings or the sign-in screen and log in with your own Grok account.'
    )
    ;(err as Error & { code?: string }).code = 'AUTH_REQUIRED'
    throw err
  }
  return auth
}
