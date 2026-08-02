import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Source must contain no invisible or direction-changing characters.
 *
 * Two separate attacks, one check.
 *
 * Trojan Source: bidirectional control characters reorder how a line DISPLAYS
 * without changing how it compiles. A reviewer reads one thing and the machine
 * runs another, and the diff looks completely ordinary. It is the rare bug class
 * where reading more carefully does not help, because the rendering is the lie.
 *
 * Hidden instructions: zero-width characters can carry text that no reviewer
 * sees but any tool reading the file does. Once this repo takes pull requests
 * from strangers and any part of review involves an assistant, a comment that is
 * invisible on screen is a way to address the reviewer directly without the
 * maintainer ever seeing it.
 *
 * Ordinary non-ASCII is fine and expected. The app uses box drawing, arrows and
 * symbols like the remote-image marker. Only characters that are invisible or
 * that reorder text are rejected.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SCAN_DIRS = ['electron', 'src', 'shared', 'tests', 'scripts']
const SCAN_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.css', '.html', '.yml', '.md'])
const SKIP_DIRS = new Set(['node_modules', 'baseline', 'current', 'diff', 'out', 'release'])

/** Codepoint to name, for an error message that explains itself. */
const FORBIDDEN = new Map<number, string>([
  // Bidirectional overrides and isolates: the Trojan Source set.
  [0x202a, 'LEFT-TO-RIGHT EMBEDDING'],
  [0x202b, 'RIGHT-TO-LEFT EMBEDDING'],
  [0x202c, 'POP DIRECTIONAL FORMATTING'],
  [0x202d, 'LEFT-TO-RIGHT OVERRIDE'],
  [0x202e, 'RIGHT-TO-LEFT OVERRIDE'],
  [0x2066, 'LEFT-TO-RIGHT ISOLATE'],
  [0x2067, 'RIGHT-TO-LEFT ISOLATE'],
  [0x2068, 'FIRST STRONG ISOLATE'],
  [0x2069, 'POP DIRECTIONAL ISOLATE'],
  [0x200e, 'LEFT-TO-RIGHT MARK'],
  [0x200f, 'RIGHT-TO-LEFT MARK'],
  [0x061c, 'ARABIC LETTER MARK'],
  // Invisible: can carry text a reviewer never sees.
  [0x200b, 'ZERO WIDTH SPACE'],
  [0x200c, 'ZERO WIDTH NON-JOINER'],
  [0x200d, 'ZERO WIDTH JOINER'],
  [0x2060, 'WORD JOINER'],
  [0xfeff, 'ZERO WIDTH NO-BREAK SPACE / BOM'],
  [0x00ad, 'SOFT HYPHEN'],
  // Invisible mathematical operators. No legitimate use in source.
  [0x2061, 'FUNCTION APPLICATION'],
  [0x2062, 'INVISIBLE TIMES'],
  [0x2063, 'INVISIBLE SEPARATOR'],
  [0x2064, 'INVISIBLE PLUS']
])

function filesToScan(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) filesToScan(full, out)
    else if (SCAN_EXT.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

interface Finding {
  file: string
  line: number
  column: number
  name: string
  codepoint: string
}

function scan(): { findings: Finding[]; fileCount: number } {
  const findings: Finding[] = []
  const files = SCAN_DIRS.flatMap((d) => filesToScan(path.join(ROOT, d)))

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    const lines = source.split(/\r?\n/)
    lines.forEach((line, i) => {
      // Iterating the string yields whole codepoints, so astral characters are
      // not split into surrogate halves and misreported.
      let column = 0
      for (const char of line) {
        column++
        const code = char.codePointAt(0)
        if (code !== undefined && FORBIDDEN.has(code)) {
          findings.push({
            file: path.relative(ROOT, file).replace(/\\/g, '/'),
            line: i + 1,
            column,
            name: FORBIDDEN.get(code) as string,
            codepoint: `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
          })
        }
      }
    })
  }
  return { findings, fileCount: files.length }
}

test('the scan actually reaches the source tree', () => {
  const { fileCount } = scan()
  // Vacuity guard: a broken path or extension list would report a clean repo.
  assert.ok(fileCount > 100, `expected to scan the whole source tree, scanned ${fileCount} files`)
})

test('the scan detects a planted character', () => {
  // Proves the detector works, without planting anything in a real file.
  const planted = `const x = 'a${String.fromCodePoint(0x202e)}b'`
  const hits = [...planted].filter((c) => FORBIDDEN.has(c.codePointAt(0) as number))
  assert.equal(hits.length, 1, 'the forbidden set failed to match a right-to-left override')
})

test('no source file contains invisible or bidirectional characters', () => {
  const { findings } = scan()
  const report = findings.map(
    (f) => `${f.file}:${f.line}:${f.column}  ${f.codepoint} ${f.name}`
  )
  assert.deepEqual(
    report,
    [],
    `Invisible or direction-changing characters found. These render as nothing, ` +
      `or reorder how a line appears without changing what it does, so a diff can ` +
      `look correct and behave otherwise:\n  ${report.join('\n  ')}`
  )
})
