/**
 * Audit a pull request's diff BEFORE checking it out.
 *
 *   npm run pr:audit 12
 *
 * The point is the ordering. `gh pr checkout` puts a stranger's files on your
 * disk, and if you then open an assistant in that directory it reads THEIR
 * CLAUDE.md as instructions and THEIR .claude/settings.json, which can define
 * hooks that run shell commands. That is code execution without anyone needing
 * to fool a model. This reads the diff as text over the API so nothing lands on
 * disk and no config is ever loaded.
 *
 * It is a triage tool, not a verdict. Everything it reports still needs eyes.
 * What it buys is knowing WHERE to look before you have looked anywhere.
 */
import { spawnSync } from 'node:child_process'

const pr = process.argv[2]
if (!pr || !/^\d+$/.test(pr)) {
  console.error('usage: npm run pr:audit <pr-number>')
  process.exit(2)
}

const isWin = process.platform === 'win32'
const gh = (args) =>
  spawnSync(isWin ? 'gh.exe' : 'gh', args, { encoding: 'utf8', shell: isWin, maxBuffer: 64 * 1024 * 1024 })

const meta = gh(['pr', 'view', pr, '--json', 'title,author,headRepositoryOwner,additions,deletions,changedFiles,isCrossRepository'])
if (meta.status !== 0) {
  console.error(`could not read PR #${pr}`)
  console.error(String(meta.stderr || '').trim())
  process.exit(1)
}
const info = JSON.parse(meta.stdout)

const diffResult = gh(['pr', 'diff', pr])
if (diffResult.status !== 0) {
  console.error(`could not read the diff for PR #${pr}`)
  process.exit(1)
}
const diff = String(diffResult.stdout)

/**
 * Files that change what YOUR tools do rather than what the app does.
 * A change here is not necessarily malicious, but it is never routine.
 */
const CONFIG_PATHS = [
  { re: /^\.claude\//i, why: 'agent configuration; settings.json can define hooks that run shell commands' },
  { re: /^CLAUDE\.md$/i, why: 'instructions an assistant reads as authoritative' },
  { re: /^\.mcp\.json$/i, why: 'declares external tool servers' },
  { re: /^\.github\/workflows\//i, why: 'runs in CI with repository credentials' },
  { re: /^\.npmrc$/i, why: 'can redirect package installs to another registry' },
  { re: /^package\.json$/i, why: 'scripts run on install and build; dependencies enter the supply chain' },
  { re: /^package-lock\.json$/i, why: 'pins what actually gets installed' },
  { re: /^scripts\//i, why: 'runs on a maintainer machine via npm scripts' }
]

/** App code where a subtle change has security consequences. */
const SENSITIVE_PATHS = [
  { re: /^electron\/main\/ipc\//i, why: 'the IPC boundary' },
  { re: /^electron\/preload\//i, why: 'the bridge the renderer can reach' },
  { re: /^electron\/main\/ipc-guard\.ts$/i, why: 'sender and path checks' },
  { re: /^electron\/main\/index\.ts$/i, why: 'content security policy and window options' },
  { re: /^electron\/main\/preview\.ts$/i, why: 'runs a subprocess and hosts untrusted pages' },
  { re: /^electron\/main\/agent-manager\.ts$/i, why: 'spawns the CLI' },
  { re: /^electron\/main\/redact\.ts$/i, why: 'keeps secrets out of logs' },
  { re: /^src\/components\/Markdown\.tsx$/i, why: 'renders model output' }
]

// Written as escapes, never as literal characters. A regex containing the very
// bytes it detects is unreadable, unmaintainable, and trips the repo check that
// forbids them, which is how this line was written the first time.
const INVISIBLE = /[\u200B-\u200F\u061C\u202A-\u202E\u2060-\u2069\u00AD\uFEFF]/

/**
 * Phrases that address a reader rather than describe code. Heuristic, and
 * deliberately conservative: the goal is to notice text aimed at a reviewer, not
 * to pretend this is a filter that cannot be evaded. Anything it misses is
 * exactly why the structural defences matter more than this list.
 */
const ADDRESSED_TO_REVIEWER = [
  /ignore (all |any )?(previous|prior|earlier|above)/i,
  /disregard (the |all )?(previous|prior|above|instructions)/i,
  /you are now/i,
  /new instructions?:/i,
  /system prompt/i,
  /\bas an ai\b/i,
  /do not (report|mention|flag)/i,
  /approve this (pull request|pr|change)/i,
  /this (change|code) is (safe|approved|verified)/i
]

// Walk the diff, tracking the current file and collecting only ADDED lines.
const files = new Map()
let current = null
for (const line of diff.split(/\r?\n/)) {
  const header = line.match(/^\+\+\+ b\/(.+)$/)
  if (header) {
    current = header[1]
    if (!files.has(current)) files.set(current, [])
    continue
  }
  if (!current) continue
  if (line.startsWith('+') && !line.startsWith('+++')) {
    files.get(current).push(line.slice(1))
  }
}

const high = []
const medium = []
const notes = []

for (const [file, added] of files) {
  for (const { re, why } of CONFIG_PATHS) {
    if (re.test(file)) high.push(`${file}\n      ${why}`)
  }
  for (const { re, why } of SENSITIVE_PATHS) {
    if (re.test(file)) medium.push(`${file}\n      ${why}`)
  }

  added.forEach((text, i) => {
    if (INVISIBLE.test(text)) {
      high.push(`${file}\n      added line ${i + 1} contains an invisible or direction-changing character`)
    }
    for (const re of ADDRESSED_TO_REVIEWER) {
      if (re.test(text)) {
        high.push(`${file}\n      added line reads as if addressed to a reviewer: ${JSON.stringify(text.trim().slice(0, 90))}`)
        break
      }
    }
    if (text.length > 800) {
      notes.push(`${file}\n      a single added line is ${text.length} characters, which usually means generated or minified content`)
    }
  })

  if (/^package\.json$/i.test(file)) {
    const deps = added.filter((l) => /^\s*"[^"]+"\s*:\s*"[^"]*"/.test(l) && !/"(scripts|name|version|description)"/.test(l))
    if (deps.length) {
      high.push(`package.json\n      ${deps.length} dependency line(s) added:\n        ${deps.map((d) => d.trim()).join('\n        ')}`)
    }
    const scripts = added.filter((l) => /(preinstall|postinstall|prepare|prepublish)/i.test(l))
    if (scripts.length) {
      high.push(`package.json\n      lifecycle script added, which runs automatically on install:\n        ${scripts.map((s) => s.trim()).join('\n        ')}`)
    }
  }
}

const dedupe = (arr) => [...new Set(arr)]

console.log(`\nPR #${pr}  ${info.title}`)
console.log(`by ${info.author?.login ?? 'unknown'}${info.isCrossRepository ? ' (from a fork)' : ''}`)
console.log(`${info.changedFiles} files, +${info.additions} -${info.deletions}\n`)

const highs = dedupe(high)
const mediums = dedupe(medium)
const others = dedupe(notes)

if (highs.length) {
  console.log('READ BY HAND BEFORE CHECKING OUT')
  for (const h of highs) console.log(`  - ${h}`)
  console.log('')
}
if (mediums.length) {
  console.log('Security-relevant app code touched')
  for (const m of mediums) console.log(`  - ${m}`)
  console.log('')
}
if (others.length) {
  console.log('Worth a glance')
  for (const n of others) console.log(`  - ${n}`)
  console.log('')
}

if (!highs.length && !mediums.length && !others.length) {
  console.log('Nothing flagged. This does not mean the change is correct, only that')
  console.log('it does not touch configuration, security-critical files, or contain')
  console.log('anything shaped like an instruction.\n')
}

console.log('Next:')
console.log(`  gh pr diff ${pr}          read it as text, nothing touches your disk`)
if (highs.length) {
  console.log('  Do NOT check this out until the items above are understood.')
  console.log('  A change under .claude/ or CLAUDE.md is read as instructions by any')
  console.log('  assistant you open in that directory.')
} else {
  console.log(`  gh pr checkout ${pr}      then: npm run verify, npm run test:visual`)
}
console.log('')

process.exit(highs.length ? 1 : 0)
