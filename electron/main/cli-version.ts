/**
 * Is the installed Grok CLI a release Gronk's `--json` parsing was verified against?
 *
 * The CLI updates itself without asking — it moved 0.2.111 → 0.2.112 unprompted
 * during one development session. Gronk reads that output by field name, and
 * both `asList()` and `mapPlugin()` degrade to nothing rather than throwing
 * (plugins-map.ts), so a rename upstream does not crash: it renders an EMPTY
 * plugin list, indistinguishable from having none installed. Silently wrong.
 * This module exists to make that mismatch legible instead.
 *
 * Split the way plugins-map.ts / cache.ts are: every parse, comparison and
 * classification below is pure and unit tested in tests/cli-version.test.ts;
 * `getCliVersion` is a thin shim that spawns the process and hands the captured
 * text to those functions.
 *
 * Nothing raw from the CLI reaches the UI — only integers parsed out of a semver
 * and a charset-checked channel token — so no redaction pass is needed here.
 */

import { cachedProbe } from './cache'
import { runGrokCli } from './grok-cli'
import type { CliVersionInfo, CliVersionStatus } from '../../shared/types'

/**
 * The CLI release Gronk's JSON parsing was actually checked against.
 *
 * "Verified" has one meaning: `tests/live-cli.test.ts` was run against a real
 * binary of this version (`GRONK_LIVE_CLI=1 npm test`) and passed — the plugin,
 * marketplace and MCP `--json` payloads still carried every field plugins-map.ts
 * reads, under the key spellings it reads them by.
 *
 * RE-RUN THAT SUITE BEFORE BUMPING THIS. Editing the constant on its own only
 * silences the warning; it does not make the shapes match.
 */
export const VERIFIED_CLI_VERSION = '1.0.5'

export interface Semver {
  major: number
  minor: number
  patch: number
}

/** A version read off the CLI, whichever command reported it. */
export interface ParsedCliVersion {
  /** Canonical "major.minor.patch". Any build hash or prerelease tag is dropped. */
  version: string
  semver: Semver
  /** e.g. "stable" — absent when the CLI did not report one. */
  channel?: string
}

/** Longest CLI output this module will look at. Version strings are tiny. */
const MAX_OUTPUT_LENGTH = 64 * 1024

/** Longest single version string. "0.2.112 (9bbd559437)" is 20 characters. */
const MAX_VERSION_LENGTH = 128

/** Digits per semver field. Six is already a million releases. */
const MAX_FIELD_DIGITS = 6

/**
 * Anchored, with trailing content allowed on purpose: `currentVersion` is
 * "0.2.112 (9bbd559437)", a semver followed by a build hash, and a prerelease
 * would arrive as "0.3.0-beta.1". The three numbers are what ordering is decided
 * on; everything after them is discarded rather than compared.
 */
const SEMVER_PREFIX = /^v?(\d+)\.(\d+)\.(\d+)/

/** Same three numbers, found anywhere: `grok --version` prefixes them with "grok ". */
const SEMVER_ANYWHERE = /(?<![\d.])(\d+)\.(\d+)\.(\d+)(?![\d])/

/** `[stable]` in the plain-text form. */
const CHANNEL_BRACKET = /\[([A-Za-z0-9._-]{1,32})\]/

const CHANNEL_CHARSET = /^[A-Za-z0-9._-]{1,32}$/

function toSemver(major: string, minor: string, patch: string): Semver | null {
  // Refused rather than rounded: Number() turns a 400-digit run into Infinity,
  // which would compare as "newer than verified" forever.
  if ([major, minor, patch].some((field) => field.length > MAX_FIELD_DIGITS)) return null
  return { major: Number(major), minor: Number(minor), patch: Number(patch) }
}

/** Read "0.2.112", "v0.2.112", "0.2.112 (9bbd559437)" or "0.3.0-beta.1". */
export function parseSemver(value: unknown): Semver | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > MAX_VERSION_LENGTH) return null
  const match = SEMVER_PREFIX.exec(text)
  return match ? toSemver(match[1], match[2], match[3]) : null
}

export function formatSemver(version: Semver): string {
  return `${version.major}.${version.minor}.${version.patch}`
}

/**
 * Numeric field-by-field ordering. A string compare gets this backwards —
 * "0.2.9" > "0.2.10" lexicographically — which is the whole reason this is a
 * function and not a `<`.
 */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return 0
}

function parseChannel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const channel = value.trim()
  return CHANNEL_CHARSET.test(channel) ? channel : undefined
}

function parsed(semver: Semver, channel: string | undefined): ParsedCliVersion {
  return { version: formatSemver(semver), semver, channel }
}

/**
 * `grok version --json` → `{"currentVersion":"0.2.112 (9bbd559437)","channel":"stable"}`.
 *
 * `version` is read as a second spelling for forward-compat only; 0.2.112 emits
 * `currentVersion`. Anything unparseable returns null so the caller can fall
 * back to the plain-text command rather than reporting a wrong version.
 */
export function parseVersionJson(stdout: unknown): ParsedCliVersion | null {
  if (typeof stdout !== 'string') return null
  const text = stdout.trim()
  if (!text || text.length > MAX_OUTPUT_LENGTH) return null

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const record = raw as Record<string, unknown>
  const semver = parseSemver(record.currentVersion) ?? parseSemver(record.version)
  if (!semver) return null
  return parsed(semver, parseChannel(record.channel))
}

/**
 * `grok --version` → `grok 0.2.112 (9bbd559437) [stable]`.
 *
 * A DIFFERENT command from `version --json`, kept because the JSON form did not
 * always exist. Only the three numbers and a bracketed channel token are taken
 * out of the line — the text itself never travels any further.
 */
export function parseVersionText(text: unknown): ParsedCliVersion | null {
  if (typeof text !== 'string') return null
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > MAX_OUTPUT_LENGTH) return null

  const match = SEMVER_ANYWHERE.exec(trimmed)
  if (!match) return null
  const semver = toSemver(match[1], match[2], match[3])
  if (!semver) return null

  const channel = CHANNEL_BRACKET.exec(trimmed)
  return parsed(semver, channel ? parseChannel(channel[1]) : undefined)
}

function message(status: CliVersionStatus, current: string, verified: string): string | undefined {
  switch (status) {
    case 'ok':
      // Silence is the point: a matching (or patch-only different) CLI must not
      // put a line of warning text in Settings.
      return undefined
    case 'newer-than-verified':
      return (
        `The Grok CLI is ${current}, newer than the ${verified} Gronk's plugin and MCP ` +
        'output parsing was verified against. If the CLI changed its output format, those ' +
        'lists can look empty or incomplete even when you do have plugins and servers ' +
        'configured. Check them with the CLI before trusting what Gronk shows.'
      )
    case 'older-than-verified':
      return (
        `The Grok CLI is ${current}, older than the ${verified} Gronk's plugin and MCP ` +
        'output parsing was verified against. Those lists can look empty or incomplete on ' +
        'an older output format. Updating the CLI is the usual fix.'
      )
    case 'unknown':
      return (
        "Gronk could not read the Grok CLI's version, so it cannot tell whether the CLI " +
        `still emits the ${verified} output format it reads. If plugin or MCP lists look ` +
        'empty, this may be why rather than because you have none.'
      )
  }
}

/**
 * Classify a version read off the CLI against the one Gronk was verified
 * against. Pure: the caller supplies the parse, and `verifiedAgainst` is a
 * parameter so ordering can be exercised without editing the constant.
 *
 * THE THRESHOLD: a MINOR or MAJOR difference warns; any patch difference is
 * `ok`. The CLI is pre-1.0, where semver puts breaking changes in the minor
 * field — 0.2.x → 0.3.x is exactly where a project of that shape is entitled to
 * rename its JSON keys, and 1.x → 2.x obviously so. Patch releases carry the
 * opposite signal: the binary self-updates through them continuously (0.2.111 →
 * 0.2.112 landed mid-session with every shape in live-cli.test.ts intact), so
 * warning on one would fire most days, be a false alarm every time, and train
 * the user to ignore the once it is real.
 *
 * Patch DISTANCE is not capped either. "0.2.112 vs 0.2.400" is still nothing but
 * a run of patch releases, and picking a count of them that means danger would
 * be inventing evidence we do not have. If a shape ever does break inside a
 * patch series, the fix is a live-CLI run and a new VERIFIED_CLI_VERSION — not a
 * threshold tuned after the fact.
 */
export function classifyCliVersion(
  version: ParsedCliVersion | null,
  verifiedAgainst: string = VERIFIED_CLI_VERSION
): CliVersionInfo {
  const verified = parseSemver(verifiedAgainst)

  // No readable version — from a missing binary, a timeout, or output in a shape
  // neither parser understands. Reported as unknown, never as a mismatch: we
  // have no evidence either way, and a fabricated "newer" is its own false alarm.
  if (!version || !verified) {
    return {
      current: version?.version,
      channel: version?.channel,
      verifiedAgainst,
      status: 'unknown',
      message: message('unknown', version?.version ?? 'unknown', verifiedAgainst)
    }
  }

  const { semver } = version
  const drifted = semver.major !== verified.major || semver.minor !== verified.minor
  const status: CliVersionStatus = !drifted
    ? 'ok'
    : compareSemver(semver, verified) > 0
      ? 'newer-than-verified'
      : 'older-than-verified'

  return {
    current: version.version,
    channel: version.channel,
    verifiedAgainst,
    status,
    message: message(status, version.version, verifiedAgainst)
  }
}

// ── Process shim ────────────────────────────────────────────────────

/**
 * Two spawns in the worst case, on a path the Settings panel hits on every open.
 * The answer only changes when the CLI updates itself, so it tolerates the same
 * order of TTL the model list does; `cachedProbe` also collapses the concurrent
 * callers a panel open produces into one run.
 */
const CLI_VERSION_TTL_MS = 5 * 60_000

/**
 * Version reporting is local work — no network call, so it must not be slow.
 * This is also the bound on the `version --json` attempt against a CLI old
 * enough not to know that subcommand: runGrokCli kills the child at the timeout
 * and resolves, so an unrecognised command costs a few seconds, not a hang.
 */
const VERSION_TIMEOUT_MS = 8_000

const versionProbe = cachedProbe(() => probeCliVersion(), { ttlMs: CLI_VERSION_TTL_MS })

export function getCliVersion(): Promise<CliVersionInfo> {
  return versionProbe.get()
}

/** Call when the configured grok binary changes — a different binary, a different version. */
export function invalidateCliVersionCache(): void {
  versionProbe.invalidate()
}

async function probeCliVersion(): Promise<CliVersionInfo> {
  const json = await runGrokCli(['version', '--json'], { timeoutMs: VERSION_TIMEOUT_MS })
  // Parsed regardless of exit code: what matters is whether the payload is
  // readable, and runGrokCli resolves rather than rejects on a missing binary.
  let version = parseVersionJson(json.stdout)

  if (!version) {
    // `version --json` did not always exist. `--version` is a separate command
    // that prints "grok 0.2.112 (9bbd559437) [stable]" — stderr is included
    // because some CLIs put the banner there.
    const plain = await runGrokCli(['--version'], { timeoutMs: VERSION_TIMEOUT_MS })
    version = parseVersionText(`${plain.stdout}\n${plain.stderr}`)
  }

  return classifyCliVersion(version)
}
