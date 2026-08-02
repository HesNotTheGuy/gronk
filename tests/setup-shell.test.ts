import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `npm run setup` is the supply-chain install: it installs with lifecycle
 * scripts disabled, scans what landed, and only then lets Electron's own
 * installer run. The scan is the whole point of the script.
 *
 * It shipped broken on Windows. run() passed `shell: process.platform ===
 * 'win32'` to every step, so cmd.exe re-parsed each command line, and cmd.exe
 * splits on spaces. The two steps launched with process.execPath therefore died
 * at `C:\Program` on any machine with Node at its default location, which is
 * most of them. The script failed closed, so it never waved malware through,
 * but the malware scan had most likely never actually run on Windows and the
 * error read like a detection rather than a path bug.
 *
 * Nothing else can catch this. CI runs `npm ci --ignore-scripts` directly and
 * never invokes setup.mjs, and the script cannot be imported without performing
 * an install, so these read the source the way tests/csp.test.ts does, plus one
 * live spawn that pins the reason the rule exists.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SETUP = fs.readFileSync(path.join(ROOT, 'scripts/setup.mjs'), 'utf8')

// Comments are stripped first, so prose explaining the shell is never mistaken
// for code asking for one. Only whole-line comments, to leave strings intact.
const CODE = SETUP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const RUN_DEF_AT = CODE.indexOf('function run(')
const RUN_DEF_END = CODE.indexOf('\n}', RUN_DEF_AT)
/** The body of run() itself. */
const RUN_DEF = CODE.slice(RUN_DEF_AT, RUN_DEF_END)
/** Everything except the definition, so every remaining `run(` is a call. */
const CALLERS = CODE.slice(0, RUN_DEF_AT) + CODE.slice(RUN_DEF_END)

/**
 * The argument list of every `run(...)` call. Paren counting rather than a
 * parser, in the spirit of tests/ipc-handler-guard.test.ts: something that
 * understood the code could be argued out of a match, and a counter cannot.
 */
function runCalls(): string[] {
  const calls: string[] = []
  for (const match of CALLERS.matchAll(/\brun\(/g)) {
    const start = (match.index ?? NaN) + match[0].length
    assert.ok(Number.isFinite(start), 'match index missing')
    let depth = 1
    let i = start
    while (i < CALLERS.length && depth > 0) {
      if (CALLERS[i] === '(') depth++
      else if (CALLERS[i] === ')') depth--
      i++
    }
    assert.equal(depth, 0, `unbalanced run( call at offset ${start}`)
    calls.push(CALLERS.slice(start, i - 1))
  }
  return calls
}

test('the scan finds the setup steps it is supposed to be checking', () => {
  // Vacuity guard. If run() is renamed or the steps are restructured, the tests
  // below would pass over an empty list and report the script as fixed.
  assert.ok(RUN_DEF_AT > -1, 'run() not found in scripts/setup.mjs')
  assert.equal(
    runCalls().length,
    3,
    'setup.mjs should have exactly three steps: install, scan, Electron binary. ' +
      'A fourth needs its own decision about the shell, so update this test rather than deleting it.'
  )
})

test('no step launched with process.execPath asks for a shell', () => {
  // This is the bug. A shell parses the program too, and the default Windows
  // Node lives at C:\Program Files\nodejs\node.exe.
  const offenders = runCalls().filter((c) => c.includes('process.execPath') && /\bshell\b/.test(c))

  assert.deepEqual(
    offenders,
    [],
    `these steps run a node binary through a shell, which splits its path at the ` +
      `first space:\n  ${offenders.join('\n  ')}`
  )
})

test('the npm step still asks for a shell on Windows', () => {
  // The other half. npm ships as npm.cmd there and spawnSync will not start a
  // .cmd without one, so dropping the shell everywhere breaks the install.
  const npm = runCalls().filter((c) => c.trimStart().startsWith("'npm'"))
  assert.equal(npm.length, 1, 'expected exactly one npm step')
  assert.match(npm[0], /shell:\s*process\.platform === 'win32'/)
})

test('run() leaves the shell off unless a step asks for it', () => {
  // A default of false is what keeps a newly added step safe. If run() turned
  // the shell back on for everything, the call-site checks above would still
  // pass and the bug would be back.
  assert.match(RUN_DEF, /\{\s*shell\s*=\s*false\s*\}/, 'run() must default to no shell')
  assert.ok(
    !/shell:\s*process\.platform/.test(RUN_DEF),
    'the platform decision belongs at the npm call site, not in run()'
  )
})

test('a shell splits a path at its spaces, and no shell runs it', () => {
  // The reason the rule exists, checked rather than asserted in a comment. This
  // is the same failure the two process.execPath steps hit on Windows, and it
  // reproduces on every platform once a shell is in the way.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gronk-setup spaced-'))
  try {
    const probe = path.join(dir, 'probe.mjs')
    fs.writeFileSync(probe, "process.stdout.write('probe-ran')\n")

    // stdio keeps stdout and drops stderr, so the half that is meant to fail
    // does not spray an error across the test run.
    const direct = spawnSync(process.execPath, [probe], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    assert.equal(direct.status, 0, 'a spaced path must run when no shell is involved')
    assert.equal(direct.stdout, 'probe-ran')

    // shell:true concatenates the program and its arguments into one string and
    // hands that to the shell, which splits it back apart on spaces. Written out
    // rather than passed as an args array because that concatenation is the bug.
    const shelled = spawnSync(`${process.execPath} ${probe}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: true
    })
    assert.notEqual(shelled.status, 0, 'a shell was expected to mangle the spaced path')
    assert.notEqual(shelled.stdout, 'probe-ran')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
