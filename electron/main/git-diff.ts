/**
 * What has the agent changed in this folder? Local git only.
 *
 * No network, no forge, no credential: this reads the working tree of the
 * folder the agent is already working in, and nothing else.
 *
 * ## Running git in a repository you do not trust
 *
 * The agent's cwd is whatever folder the user opened, which routinely includes
 * a repository they cloned five minutes ago to look at. `git diff` reads that
 * repository's own `.git/config`, and several config keys name a program that
 * git will EXECUTE. Clicking a diff must not run a stranger's code, the same
 * way clicking Preview must not: `resolveCommand` in preview.ts returns the
 * literal `npm run dev` after seeing a dev script exists rather than returning
 * the script's body, for exactly this reason.
 *
 * Every invocation therefore disables them explicitly, and each one below is a
 * command git would otherwise run:
 *
 * - `--no-ext-diff`: `diff.external` names an executable that replaces git's
 *   own diff engine. Set in the repository's config, it runs on every diff.
 * - `--no-textconv`: a `diff.<driver>.textconv` filter is a command run over a
 *   file's contents before diffing it, selected per path by `.gitattributes`.
 * - **Content filters are the ones a fixed list cannot cover.**
 *   `filter.<driver>.clean`, `.smudge` and `.process` are commands too, chosen
 *   per path by `.gitattributes` exactly the way textconv is, and `--no-textconv`
 *   does not touch them. `git status` runs a clean filter to hash a changed file,
 *   so listing alone is enough to trigger one. The driver name is whatever the
 *   repository invented, so there is no flag to pre-empt: the drivers defined in
 *   this repository are read first with `git config --list`, which executes
 *   nothing, and each one is then explicitly emptied for the real call. Emptied
 *   rather than refused, because `filter.lfs.*` is git-lfs and perfectly ordinary.
 * - `-c core.fsmonitor=`: a filesystem monitor hook is a program git runs to
 *   ask what changed. `git status` is precisely where it fires.
 * - `-c diff.external=` and `-c core.pager=cat`: belt and braces for the two
 *   above; a pager is also a spawned program.
 * - `-c credential.helper=` and `GIT_TERMINAL_PROMPT=0`: credential helpers
 *   are executables. Nothing here touches the network, so any attempt to
 *   authenticate is already wrong and must not run a helper or block on a
 *   prompt.
 * - `GIT_CONFIG_NOSYSTEM=1` and `GIT_ATTR_NOSYSTEM=1`: drop `/etc/gitconfig`
 *   and the system attributes file from the lookup. The user's own `~/.gitconfig`
 *   is deliberately still honoured; the threat is the repository, not the user.
 * - `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and friends are removed from the
 *   inherited environment. They override which repository git operates on, so a
 *   shell that exported one would silently point this at a different folder than
 *   the agent's, which is the one thing this must never do.
 * - `--literal-pathspecs`: without it a path is pathspec syntax, so a file
 *   named `:(exclude)x` or a renderer-supplied `:(glob)**` would be read as
 *   magic rather than as a name.
 * - `--no-optional-locks`: status may otherwise refresh and write the index of
 *   a repository the user only asked to look at.
 *
 * ## The other rules this file follows
 *
 * Spawned as `(binary, argv[])` with no shell, never a concatenated string.
 * Paths sit after a literal `--` so nothing a caller supplies can arrive as a
 * flag. Output is redacted before it leaves the main process, because a working
 * tree contains whatever the agent just wrote into it, including a `.env`. And
 * `cwd` comes from the agent, never from `process.cwd()`.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { isPathInside } from './ipc-guard'
import { redactSecrets } from './redact'

/** Files listed. A working tree with more than this is not a review surface. */
export const MAX_FILES = 200

/** Bytes of diff text returned for one file, before truncation is reported. */
export const MAX_DIFF_BYTES = 256 * 1024

/** A git call that hangs must not hold the handler open. */
const GIT_TIMEOUT_MS = 10_000

/**
 * Read budget for the config listing, which must never be cut.
 * A repository chooses how big its own config is, so this is sized well past
 * anything real and a listing that still exceeds it is a refusal.
 */
const CONFIG_LIST_MAX_BYTES = 8 * 1024 * 1024

export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'renamed' | 'conflicted'

export interface ChangedFile {
  /** Repository-relative, forward slashes, exactly as git reported it. */
  path: string
  status: ChangeStatus
  /** Staged, unstaged, or both. Shown, never used to decide anything. */
  staged: boolean
}

export interface WorkingTreeChanges {
  /** False when there is no agent folder, or it is not a git repository. */
  repo: boolean
  reason?: 'no-folder' | 'not-a-repo' | 'git-failed'
  message?: string
  files: ChangedFile[]
  /** More than MAX_FILES changed; `files` is the first MAX_FILES of them. */
  truncated: boolean
}

export interface FileDiff {
  path: string
  status: ChangeStatus
  text: string
  truncated: boolean
  /** Git said the file is binary, or we found a NUL byte in an untracked one. */
  binary: boolean
}

/**
 * Config and environment that make git safe to run in a repository nobody has
 * read. Every entry is explained in the module comment; none of them is
 * cosmetic.
 */
const HARDENING_ARGS = [
  '-c',
  'core.pager=cat',
  '-c',
  'diff.external=',
  '-c',
  'core.fsmonitor=',
  '-c',
  'credential.helper=',
  '--literal-pathspecs',
  '--no-optional-locks'
]

/** Exactly the argv git is invoked with. Exported so a test can assert it. */
export function hardenedArgs(args: string[]): string[] {
  return [...HARDENING_ARGS, ...args]
}

/**
 * Environment variables that would move git to another repository. Inherited
 * from whatever shell launched the app, so they are dropped rather than trusted:
 * `cwd` is the only thing allowed to decide where this runs.
 */
const REDIRECTING_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES'
]

export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of REDIRECTING_ENV) delete env[key]
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_OPTIONAL_LOCKS: '0',
    // Stable, parseable output whatever the user's locale is.
    LC_ALL: 'C'
  }
}

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  /** Output hit the read budget. A caller reading config MUST treat this as a
   *  failure: partial config is indistinguishable from "the key is not set". */
  truncated: boolean
}

/**
 * One git invocation. argv only, no shell, and the hardening is prepended here
 * rather than at each call site so a new command cannot forget it.
 */
export function runGit(
  cwd: string,
  args: string[],
  extraConfig: string[] = [],
  maxStdout = MAX_DIFF_BYTES * 2
): Promise<GitResult> {
  return new Promise((resolve) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn('git', [...extraConfig, ...hardenedArgs(args)], {
        cwd,
        env: gitEnv(),
        windowsHide: true,
        shell: false
      })
    } catch (err) {
      resolve({
        ok: false,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        truncated: false
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let killed = false
    let truncated = false
    const timer = setTimeout(() => {
      killed = true
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }, GIT_TIMEOUT_MS)

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (c: string) => {
      // Bounded while reading, not after: a pathological repository should not
      // be able to make the main process hold hundreds of megabytes first.
      // Whether the bound was reached is reported, because for a caller reading
      // config a silent cut looks exactly like an absent key.
      if (stdout.length < maxStdout) stdout += c
      else truncated = true
    })
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (c: string) => {
      if (stderr.length < 8192) stderr += c
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, stdout: '', stderr: err.message, truncated: false })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        ok: !killed && code === 0,
        stdout,
        stderr: killed ? 'git took too long and was stopped' : stderr,
        truncated
      })
    })
  })
}

/**
 * Driver names out of `git config --list --name-only`.
 *
 * A name is only accepted if it is plainly a name. Anything else means the
 * emptying below could not be written faithfully, and the caller refuses rather
 * than running with a filter it did not manage to disable.
 */
/**
 * The listing is separated by NEWLINES and by nothing else.
 *
 * Deliberately not "every line terminator". U+2028 and U+2029 are line
 * terminators to a JavaScript regex but they are ordinary characters to git, so
 * splitting on them would break a hostile driver name into two harmless-looking
 * halves, neither of which is recognised as a filter key. The name has to stay
 * whole in order to be judged unsafe.
 */
const LINE_BREAK = new RegExp(String.fromCharCode(10))

const FILTER_PREFIX = 'filter.'
const FILTER_COMMAND_KEYS = ['.clean', '.smudge', '.process']
const SAFE_DRIVER_NAME = /^[A-Za-z0-9._-]+$/

/**
 * Driver names out of `git config --list --name-only`.
 *
 * Deliberately string operations rather than one regex over the whole key.
 * A regex is the wrong tool here because `.` in ECMAScript does not match
 * U+2028, U+2029, `\r` or `\n`, so a driver named with one of those simply
 * fails to match, and a name that fails to match is a name that is neither
 * emptied nor refused, which is a bypass rather than a parse error. Splitting
 * the key by its fixed prefix and suffix means anything under `filter.` is
 * always seen, and only the middle is judged.
 *
 * `unsafe` is therefore the answer for every driver whose name cannot be
 * written back into a `-c filter.<name>.clean=` faithfully, and the caller
 * refuses on it. Failing closed is the point: the alternative is running with a
 * filter this code believed it had disabled.
 */
export function parseFilterDrivers(configList: string): { names: string[]; unsafe: boolean } {
  const names = new Set<string>()
  let unsafe = false
  // Config key names cannot contain a newline, so the listing is read line by
  // line. Every line-terminator form is split on, not just the common two.
  for (const raw of configList.split(LINE_BREAK)) {
    const line = raw.trim()
    if (!line.startsWith(FILTER_PREFIX)) continue
    const suffix = FILTER_COMMAND_KEYS.find((key) => line.endsWith(key))
    if (!suffix) continue
    const name = line.slice(FILTER_PREFIX.length, line.length - suffix.length)
    if (!name || !SAFE_DRIVER_NAME.test(name)) {
      unsafe = true
      continue
    }
    names.add(name)
  }
  return { names: [...names], unsafe }
}

/** `-c` pairs that empty every command half of a content filter. */
export function filterOverrides(names: string[]): string[] {
  const out: string[] = []
  for (const name of names) {
    out.push('-c', `filter.${name}.clean=`)
    out.push('-c', `filter.${name}.smudge=`)
    out.push('-c', `filter.${name}.process=`)
  }
  return out
}

/**
 * Read this repository's filter drivers so they can be emptied for the real
 * call. `git config --list` parses config and runs nothing, which is what makes
 * it safe to do first.
 */
async function filterHardening(
  cwd: string
): Promise<{ args: string[] } | { error: string }> {
  // A generous budget of its own. On the shared diff budget a large enough
  // config, which a repository chooses freely, would be cut short and the
  // filter it defines would be invisible here while still being live for the
  // command that follows.
  const listed = await runGit(cwd, ['config', '--list', '--name-only'], [], CONFIG_LIST_MAX_BYTES)

  // Fail closed on every uncertainty. "Discovery did not work" and "there is
  // nothing to disable" look identical from here, and only one of them is safe
  // to act on.
  if (!listed.ok || listed.truncated) {
    return {
      error:
        'This repository has a configuration this app could not read in full, so its changes were not read.'
    }
  }
  const { names, unsafe } = parseFilterDrivers(listed.stdout)
  if (unsafe) {
    return {
      error:
        'This repository defines a content filter whose name cannot be safely disabled, so its changes were not read.'
    }
  }
  return { args: filterOverrides(names) }
}

/**
 * Is this a git repository, without spawning anything?
 *
 * `.git` is a directory in a normal clone and a file in a worktree or submodule,
 * so both count. Deciding this from the filesystem keeps the "not a repository"
 * message a statement rather than a git error forwarded to the user, and means
 * an ordinary folder never starts a process at all.
 */
export function isGitRepo(cwd: string): boolean {
  try {
    // Only this folder, never an ancestor.
    //
    // Walking up looks friendlier and is worse. Porcelain paths are relative to
    // the REPOSITORY ROOT while everything here resolves them against the
    // agent's folder, so from a subdirectory the listing would enumerate the
    // whole ancestor repository, including files the agent cannot reach, and a
    // row would then show a different file's contents under the name shown. A
    // home directory that happens to be a git repository would do that to every
    // project inside it. Refusing is fail-closed and merely unhelpful.
    return fs.existsSync(path.join(cwd, '.git'))
  } catch {
    return false
  }
}

/** Porcelain v1 status letters to something a person reads. */
export function statusFromCode(index: string, worktree: string): ChangeStatus {
  if (index === '?' || worktree === '?') return 'untracked'
  if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A')) return 'conflicted'
  if (index === 'R') return 'renamed'
  if (index === 'D' || worktree === 'D') return 'deleted'
  if (index === 'A') return 'added'
  return 'modified'
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * NUL-separated because a filename may contain anything a filesystem allows,
 * including a newline, and the line-based form quotes those into an escaped
 * shape that would then have to be unescaped correctly.
 */
export function parseStatus(stdout: string): ChangedFile[] {
  const files: ChangedFile[] = []
  for (const entry of stdout.split('\0')) {
    if (entry.length < 4) continue
    const index = entry[0]
    const worktree = entry[1]
    const filePath = entry.slice(3)
    if (!filePath) continue
    files.push({
      path: filePath,
      status: statusFromCode(index, worktree),
      staged: index !== ' ' && index !== '?'
    })
  }
  return files
}

/** Everything changed in the working tree, or why there is nothing to show. */
export async function workingTreeChanges(
  cwd: string | null,
  precomputed?: { args: string[] } | { error: string }
): Promise<WorkingTreeChanges> {
  // Null is refuse. Falling back to process.cwd() here would point this at
  // Gronk's own installation directory, which is both wrong and the exact
  // pattern the filesystem jail exists to prevent.
  if (!cwd) {
    return { repo: false, reason: 'no-folder', files: [], truncated: false }
  }
  if (!isGitRepo(cwd)) {
    return { repo: false, reason: 'not-a-repo', files: [], truncated: false }
  }

  // Reused when the caller has already done the discovery, so one user action is
  // one `git config` rather than one per internal step.
  const hardening = precomputed ?? (await filterHardening(cwd))
  if ('error' in hardening) {
    return { repo: true, reason: 'git-failed', message: hardening.error, files: [], truncated: false }
  }

  const result = await runGit(
    cwd,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'],
    hardening.args
  )
  if (!result.ok) {
    return {
      repo: true,
      reason: 'git-failed',
      message: redactSecrets(result.stderr).slice(0, 400) || 'git status failed',
      files: [],
      truncated: false
    }
  }

  const all = parseStatus(result.stdout)
  return {
    repo: true,
    files: all.slice(0, MAX_FILES),
    truncated: all.length > MAX_FILES
  }
}

/**
 * Cut to a budget on a line boundary, so a diff never ends mid-line.
 *
 * The budget is measured in BYTES, not in string length. Those are the same
 * number only for ASCII: a file of CJK or emoji is two to four bytes per
 * character, so a length check against a byte constant would cut a 600 KB file
 * down to a third of itself and then report that nothing had been cut.
 */
export function capText(
  text: string,
  maxBytes = MAX_DIFF_BYTES
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  const lastBreak = cut.lastIndexOf('\n')
  // Cutting back to the last complete line removes a partial character with it,
  // but only when the budget contained a newline at all. A single very long
  // line has none, so the dangling replacement character is trimmed directly:
  // showing U+FFFD would be this code corrupting the file, not the file.
  const kept = lastBreak > 0 ? cut.slice(0, lastBreak) : cut.replace(/\ufffd+$/, '')
  return { text: kept, truncated: true }
}

/**
 * An untracked file rendered as an all-added block.
 *
 * `git diff` says nothing about a file it does not track, and the alternatives
 * are worse: `--no-index` against the null device is not portable, and staging
 * the file with `add -N` would write to the index of a repository the user only
 * asked to look at. Reading it directly is honest about what it is.
 */
export function untrackedDiff(bytes: Buffer, relPath: string, moreToRead = false): FileDiff {
  if (bytes.includes(0)) {
    return { path: relPath, status: 'untracked', text: '', truncated: false, binary: true }
  }
  const capped = capText(bytes.toString('utf8'))
  // Redacted like every other subprocess output, and for a sharper reason: an
  // untracked file is exactly where a freshly written `.env` lives, so this is
  // the branch most likely to be holding a live key.
  const lines = redactSecrets(capped.text)
    .split('\n')
    .map((line) => `+${line}`)
  return {
    path: relPath,
    status: 'untracked',
    text: ['--- /dev/null', `+++ ${relPath}`, ...lines].join('\n'),
    truncated: capped.truncated || moreToRead,
    binary: false
  }
}

/**
 * The diff for one file.
 *
 * `relPath` has arrived from the renderer, so it is resolved against the agent's
 * folder and refused if it lands outside. Realpath before the containment check
 * rather than after: a symlink inside the project is a lexical child of it and
 * points wherever it likes, and `isPathInside` compares strings by contract.
 */
export async function fileDiff(
  cwd: string | null,
  relPath: string
): Promise<FileDiff | { error: string }> {
  if (!cwd) return { error: 'No project folder is open.' }
  if (!isGitRepo(cwd)) return { error: 'That folder is not a git repository.' }

  const resolvedRoot = safeRealpath(cwd)
  const resolvedTarget = resolveExisting(path.resolve(cwd, relPath))
  if (!resolvedRoot || !resolvedTarget) return { error: 'That path could not be resolved.' }
  // (root, target), in that order. Reversed, this asks whether the project is
  // inside the file, which refuses every real path and would accept an ancestor.
  if (!isPathInside(resolvedRoot, resolvedTarget)) {
    return { error: 'That file is outside the project folder.' }
  }

  // The status is re-derived here rather than taken from the renderer.
  //
  // It selects which branch runs, and the untracked branch reads bytes straight
  // off the disk. Trusting a status sent over IPC would therefore hand the
  // renderer "read any file inside the project, whether or not git thinks it
  // changed", which is a capability this app deliberately does not have:
  // `gronk:list-project-files` returns names and never bytes.
  const hardening = await filterHardening(cwd)
  if ('error' in hardening) return { error: hardening.error }

  const changes = await workingTreeChanges(cwd, hardening)
  if (!changes.repo || changes.reason) {
    // Carries the refusal reason rather than flattening every one of them into
    // "no changes to show", which would describe a repository that was never read.
    return { error: changes.message || 'That folder could not be read.' }
  }
  const entry = changes.files.find((f) => f.path === relPath)
  if (!entry) return { error: 'That file has no changes to show.' }
  const status = entry.status

  if (status === 'untracked') {
    try {
      const stat = fs.statSync(resolvedTarget)
      if (!stat.isFile()) return { error: 'That is not a file.' }
      const fd = fs.openSync(resolvedTarget, 'r')
      try {
        const buffer = Buffer.alloc(Math.min(stat.size, MAX_DIFF_BYTES + 1))
        const read = fs.readSync(fd, buffer, 0, buffer.length, 0)
        return untrackedDiff(buffer.subarray(0, read), relPath, stat.size > MAX_DIFF_BYTES)
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) {
      // Redacted like everything else leaving this module: an fs error carries
      // an absolute path, and paths are what redactSecrets shortens.
      return { error: redactSecrets(err instanceof Error ? err.message : String(err)) }
    }
  }

  // HEAD is the comparison, so a staged change shows alongside an unstaged one
  // rather than disappearing the moment the agent stages it.
  const result = await runGit(
    cwd,
    ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--no-color', '--', relPath],
    hardening.args
  )
  if (!result.ok) {
    return { error: redactSecrets(result.stderr).slice(0, 400) || 'git diff failed' }
  }

  const redacted = redactSecrets(result.stdout)
  const capped = capText(redacted)
  return {
    path: relPath,
    status,
    text: capped.text,
    truncated: capped.truncated,
    binary: /^Binary files .* differ$/m.test(capped.text)
  }
}

/**
 * Realpath the deepest part of this path that exists, and put the rest back.
 *
 * A deleted file has no realpath at all, and refusing on that would make every
 * deleted file unviewable when a deletion is one of the changes most worth
 * looking at. Resolving the deepest existing ancestor still defeats a symlink
 * anywhere along the path, which is what the containment check needs.
 */
function resolveExisting(target: string): string | null {
  let dir = target
  const tail: string[] = []
  for (;;) {
    const real = safeRealpath(dir)
    if (real) return tail.length ? path.join(real, ...tail) : real
    const parent = path.dirname(dir)
    if (parent === dir) return null
    tail.unshift(path.basename(dir))
    dir = parent
  }
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p)
  } catch {
    try {
      return fs.realpathSync(p)
    } catch {
      return null
    }
  }
}
