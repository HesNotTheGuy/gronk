import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  capText,
  filterOverrides,
  parseFilterDrivers,
  fileDiff,
  gitEnv,
  hardenedArgs,
  isGitRepo,
  parseStatus,
  statusFromCode,
  untrackedDiff,
  workingTreeChanges
} from '../electron/main/git-diff'
import { diffLineTone, shortPath, statusLabel } from '../src/lib/git-changes'

/**
 * Reading a working tree that belongs to somebody else.
 *
 * The sharp risk here is not the diff, it is that `git diff` obeys the
 * repository's own `.git/config`, and several keys there name a program git
 * will execute. The agent's folder is whatever the user opened, which includes
 * a repository they cloned an hour ago. So the centre of this file is a real
 * repository with a hostile config, run through the real code path, checking
 * that the command it asked for never ran.
 */

let tmp = ''
let hasGit = true

/** Setup only. Deliberately NOT through runGit: that is the thing under test. */
function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  })
}

before(() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
  } catch {
    hasGit = false
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gronk-git-'))
})

after(() => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* a locked file on Windows is not a test failure */
  }
})

/** A repository with one committed file, one edit, and one new file. */
function makeRepo(name: string): string {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\ntwo\nthree\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-qm', 'first'])
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'one\nTWO\nthree\n')
  fs.writeFileSync(path.join(dir, 'fresh.txt'), 'brand new\n')
  return dir
}


/** A command that proves it ran, by leaving a file behind. */
function writeMarker(target: string): string {
  const node = process.execPath.split('\\').join('/')
  const out = target.split('\\').join('/')
  return '"' + node + '" -e "require(\'fs\').writeFileSync(process.argv[1],\'x\')" "' + out + '"'
}

// ── The argv and environment every call carries ─────────────────────

test('THE HARDENING IS ON EVERY CALL, not on the ones that looked risky', () => {
  const args = hardenedArgs(['status'])
  for (const expected of [
    'core.pager=cat',
    'diff.external=',
    'core.fsmonitor=',
    'credential.helper='
  ]) {
    assert.ok(args.includes(expected), `missing -c ${expected}`)
  }
  assert.ok(args.includes('--literal-pathspecs'), 'a path could be read as pathspec magic')
  assert.ok(args.includes('--no-optional-locks'), 'status may write the index without this')
  assert.equal(args[args.length - 1], 'status', 'the caller args must come last')
})

test('the environment refuses system config, prompts and askpass', () => {
  const env = gitEnv()
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1')
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(env.GIT_ASKPASS, '')
  assert.equal(env.LC_ALL, 'C', 'porcelain parsing must not depend on locale')
})

test('the diff command names --no-ext-diff and --no-textconv itself', () => {
  // They are flags of `git diff` rather than of `git`, so they cannot live in
  // the shared prefix and have to be at the one call site that diffs.
  const source = fs.readFileSync(
    new URL('../electron/main/git-diff.ts', import.meta.url),
    'utf8'
  )
  const diffCall = source.slice(source.indexOf("'diff',"), source.indexOf("'--',"))
  assert.match(diffCall, /--no-ext-diff/)
  assert.match(diffCall, /--no-textconv/)
})

// ── The case that matters: a repository that wants to run something ──

test('A HOSTILE .git/config DOES NOT GET TO RUN A COMMAND', async (t) => {
  if (!hasGit) return t.skip('git is not installed')
  const dir = makeRepo('hostile')

  // Both keys name a program git executes: one replaces the diff engine, the
  // other is run over a file's contents before diffing it. Each writes a marker
  // file, so "did it run" is a question the filesystem answers.
  const marker = path.join(tmp, 'EXTERNAL_RAN')
  const textconvMarker = path.join(tmp, 'TEXTCONV_RAN')
  const node = process.execPath
  const write = (target: string) =>
    `"${node.replace(/\\/g, '/')}" -e "require('fs').writeFileSync(process.argv[1],'x')" "${target.replace(/\\/g, '/')}"`

  git(dir, ['config', 'diff.external', write(marker)])
  git(dir, ['config', 'diff.hostile.textconv', write(textconvMarker)])
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* diff=hostile\n')

  const result = await fileDiff(dir, 'tracked.txt')
  assert.ok(!('error' in result), `diff failed: ${'error' in result ? result.error : ''}`)

  assert.equal(fs.existsSync(marker), false, 'diff.external was executed')
  assert.equal(fs.existsSync(textconvMarker), false, 'a textconv filter was executed')
  // And the diff still worked, which is what makes the refusal worth anything.
  assert.match((result as { text: string }).text, /-two/)
  assert.match((result as { text: string }).text, /\+TWO/)
})

test('a hostile config does not get to run a command during the file listing either', async (t) => {
  if (!hasGit) return t.skip('git is not installed')
  const dir = makeRepo('hostile-status')
  const marker = path.join(tmp, 'FSMONITOR_RAN')
  const node = process.execPath
  git(dir, [
    'config',
    'core.fsmonitor',
    `"${node.replace(/\\/g, '/')}" -e "require('fs').writeFileSync(process.argv[1],'x')" "${marker.replace(/\\/g, '/')}"`
  ])

  const changes = await workingTreeChanges(dir)
  assert.equal(changes.repo, true)
  assert.equal(fs.existsSync(marker), false, 'core.fsmonitor was executed')
})


test('A CONTENT FILTER DOES NOT GET TO RUN EITHER, on listing or on diff', async (t) => {
  if (!hasGit) return t.skip('git is not installed')
  const dir = makeRepo('hostile-filter')

  // The one a fixed list of flags cannot cover. `filter.<driver>.clean` is a
  // command, selected per path by .gitattributes exactly like textconv, and
  // --no-textconv does not touch it. `git status` runs it to hash a changed
  // file, so listing alone is enough. The driver name is whatever the
  // repository invented, which is why it has to be discovered and emptied
  // rather than pre-empted by a fixed flag.
  const cleanMarker = path.join(tmp, 'CLEAN_RAN')
  const processMarker = path.join(tmp, 'PROCESS_RAN')

  git(dir, ['config', 'filter.hostile.clean', writeMarker(cleanMarker)])
  git(dir, ['config', 'filter.other.process', writeMarker(processMarker)])
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=hostile\n')

  const changes = await workingTreeChanges(dir)
  assert.equal(changes.repo, true)
  assert.equal(fs.existsSync(cleanMarker), false, 'a clean filter ran during the listing')

  const result = await fileDiff(dir, 'tracked.txt')
  assert.ok(!('error' in result), 'the diff failed')
  assert.equal(fs.existsSync(cleanMarker), false, 'a clean filter ran during the diff')
  assert.equal(fs.existsSync(processMarker), false, 'a process filter ran')
  assert.match((result as { text: string }).text, /\+TWO/, 'the diff stopped working')
})

test('the drivers to empty are read off the config listing, and odd names refuse', () => {
  const listed = [
    'filter.lfs.clean',
    'filter.lfs.smudge',
    'filter.lfs.process',
    'filter.my.driver.clean',
    'core.pager',
    'diff.external'
  ].join('\n')
  const parsed = parseFilterDrivers(listed)
  assert.deepEqual(parsed.names.sort(), ['lfs', 'my.driver'])
  assert.equal(parsed.unsafe, false)

  // Emptied rather than refused: filter.lfs.* is git-lfs, and refusing outright
  // would make this useless in any repository that uses it.
  assert.deepEqual(filterOverrides(['lfs']), [
    '-c',
    'filter.lfs.clean=',
    '-c',
    'filter.lfs.smudge=',
    '-c',
    'filter.lfs.process='
  ])

  // A name that cannot be written back faithfully is a refusal, not a guess.
  assert.equal(parseFilterDrivers('filter.a=b.clean').unsafe, true)
  assert.equal(parseFilterDrivers('filter.a b.clean').unsafe, true)
})

test('AN UNTRACKED .env IS REDACTED, the branch most likely to be holding one', async (t) => {
  if (!hasGit) return t.skip('git is not installed')
  const dir = makeRepo('secrets')
  fs.writeFileSync(
    path.join(dir, '.env'),
    'XAI_API_KEY=xai-abcdef0123456789abcdef\nAuthorization: Bearer sk-livetoken1234567890\n'
  )

  const result = await fileDiff(dir, '.env')
  assert.ok(!('error' in result))
  const text = (result as { text: string }).text
  assert.equal(text.includes('xai-abcdef0123456789abcdef'), false, 'a live key crossed IPC')
  assert.equal(text.includes('sk-livetoken1234567890'), false, 'a bearer token crossed IPC')
  assert.match(text, /redacted/i, 'the line vanished rather than being redacted')
})

test('A DELETED FILE IS VIEWABLE: a path that no longer exists is not a refusal', async (t) => {
  if (!hasGit) return t.skip('git is not installed')
  const dir = makeRepo('deleted')
  fs.rmSync(path.join(dir, 'tracked.txt'))

  const changes = await workingTreeChanges(dir)
  assert.equal(changes.files.find((f) => f.path === 'tracked.txt')?.status, 'deleted')

  // It has no realpath of its own, so containment is decided on the deepest
  // ancestor that does exist rather than by refusing the file.
  const result = await fileDiff(dir, 'tracked.txt')
  assert.ok(!('error' in result), 'a deleted file was refused')
  assert.match((result as { text: string }).text, /-one/)
})

test('THE STATUS IS NOT THE RENDERERS TO CHOOSE: an unchanged file is refused', async (t) => {
  if (!hasGit) return t.skip('git is not installed')
  const dir = makeRepo('status-trust')
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n')
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'private\n')
  git(dir, ['add', '.gitignore'])
  git(dir, ['commit', '-qm', 'ignore'])

  // Neither of these is in the change list. The untracked branch reads bytes
  // straight off the disk, so letting the renderer pick the branch would turn
  // this into "read any file inside the project", a capability the app
  // deliberately does not have, since list-project-files returns names only.
  for (const attempt of ['ignored.txt', '.gitignore', '.git/config']) {
    assert.ok('error' in (await fileDiff(dir, attempt)), attempt + ' was readable')
  }
})

test('the environment cannot be redirected at another repository', () => {
  // Inherited from whatever shell launched the app. GIT_DIR moves git to a
  // different repository entirely while the cwd check still passes.
  const env = gitEnv()
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) {
    assert.equal(key in env, false, key + ' survived into the git environment')
  }
  assert.equal(env.GIT_ATTR_NOSYSTEM, '1')
})

test('ONLY THIS FOLDER COUNTS AS THE REPOSITORY, never an ancestor', () => {
  const nested = path.join(tmp, 'nested-check', 'a', 'b')
  fs.mkdirSync(path.join(tmp, 'nested-check', '.git'), { recursive: true })
  fs.mkdirSync(nested, { recursive: true })

  // Walking up looks friendlier and is worse: porcelain paths are relative to
  // the repository ROOT while everything here resolves them against the agent's
  // folder. From a subdirectory the listing would enumerate the whole ancestor
  // repository, and a row would show one file's contents under another file's
  // name. A home directory that happens to be a repository would do that to
  // every project inside it.
  assert.equal(isGitRepo(nested), false)
  assert.equal(isGitRepo(path.join(tmp, 'nested-check')), true)
})

test('A DRIVER NAME HIDDEN BEHIND A LINE TERMINATOR IS REFUSED, not skipped', () => {
  // The gap that made the first version of this bypassable. `.` in a JavaScript
  // regex does not match U+2028, U+2029, CR or LF, so a driver named with one
  // failed to match the key pattern and was then neither emptied nor refused:
  // a name that does not parse was treated as a name that is not there.
  //
  // Splitting on those characters is the same bug from the other side, since
  // they are ordinary characters to git and splitting would break the hostile
  // key into two halves that each look harmless. The listing is separated by
  // newlines and by nothing else.
  for (const hidden of ['a b', 'a b', 'a\rb', 'a b', 'a=b', 'a\tb']) {
    const parsed = parseFilterDrivers('filter.' + hidden + '.clean')
    assert.equal(parsed.unsafe, true, JSON.stringify(hidden) + ' was neither emptied nor refused')
    assert.deepEqual(parsed.names, [])
  }

  // ...while ordinary names, including dotted ones, still parse.
  const ok = parseFilterDrivers('core.pager\nfilter.lfs.clean\nfilter.my.driver.process')
  assert.deepEqual(ok.names.sort(), ['lfs', 'my.driver'])
  assert.equal(ok.unsafe, false)
})

test('A CONFIG TOO BIG TO READ IS A REFUSAL, not an empty answer', async (t) => {
  if (!hasGit) return t.skip('git is not installed')
  const dir = makeRepo('padded-config')
  const marker = path.join(tmp, 'PADDED_RAN')
  git(dir, ['config', 'filter.hostile.clean', writeMarker(marker)])
  fs.writeFileSync(path.join(dir, '.gitattributes'), '* filter=hostile\n')

  // A repository chooses how big its own config is. Padding it past the read
  // budget made discovery return partial output that looked exactly like "no
  // filter is defined", while the filter stayed live for the command that
  // followed. Discovery now has its own budget and reports being cut.
  const padding: string[] = []
  for (let i = 0; i < 40_000; i++) padding.push('[pad' + i + ']\n\tkey = ' + 'x'.repeat(180) + '\n')
  fs.appendFileSync(path.join(dir, '.git', 'config'), padding.join(''))

  const changes = await workingTreeChanges(dir)
  assert.equal(fs.existsSync(marker), false, 'a clean filter ran behind a padded config')
  // Either it read the whole config and emptied the filter, or it refused. Both
  // are safe; silently listing files with the filter live is not.
  if (changes.reason) assert.match(changes.message ?? '', /could not read/i)

  const result = await fileDiff(dir, 'tracked.txt')
  assert.equal(fs.existsSync(marker), false, 'a clean filter ran on the diff behind a padded config')
  if ('error' in result) assert.match(result.error, /could not read|no changes/i)
})

test('a refusal to read the config is reported as itself, not as "no changes"', async (t) => {
  if (!hasGit) return t.skip('git is not installed')
  const dir = makeRepo('refusal-message')
  git(dir, ['config', 'filter.a=b.clean', 'anything'])

  const result = await fileDiff(dir, 'tracked.txt')
  assert.ok('error' in result)
  // "That file has no changes to show" would describe a repository that was
  // never read, which is a different and misleading statement.
  assert.match((result as { error: string }).error, /content filter/i)
})

// ── Refusals ────────────────────────────────────────────────────────

test('NO FOLDER IS A REFUSAL, never a fallback to the process cwd', async () => {
  // Falling back would point this at Gronk's own directory, which is the whole
  // filesystem jail undone.
  const changes = await workingTreeChanges(null)
  assert.equal(changes.repo, false)
  assert.equal(changes.reason, 'no-folder')
  assert.deepEqual(changes.files, [])

  const diff = await fileDiff(null, 'anything.txt')
  assert.ok('error' in diff)
})

test('a folder that is not a repository says so instead of surfacing a git error', async () => {
  const plain = path.join(tmp, 'plain')
  fs.mkdirSync(plain, { recursive: true })
  const changes = await workingTreeChanges(plain)
  assert.equal(changes.repo, false)
  assert.equal(changes.reason, 'not-a-repo')
  assert.equal(isGitRepo(plain), false)
})

test('A PATH OUT OF THE PROJECT IS REFUSED', async (t) => {
  if (!hasGit) return t.skip('git is not installed')
  const dir = makeRepo('escape')
  fs.writeFileSync(path.join(tmp, 'outside.txt'), 'not yours\n')

  for (const attempt of ['../outside.txt', '../../outside.txt', path.join(tmp, 'outside.txt')]) {
    const result = await fileDiff(dir, attempt)
    assert.ok('error' in result, `${attempt} was not refused`)
  }
})

test('a symlink inside the project pointing out of it is refused', async (t) => {
  if (!hasGit) return t.skip('git is not installed')
  const dir = makeRepo('symlink')
  const secret = path.join(tmp, 'secret.txt')
  fs.writeFileSync(secret, 'not yours\n')
  try {
    fs.symlinkSync(secret, path.join(dir, 'looks-local.txt'))
  } catch {
    return t.skip('this platform does not allow creating symlinks here')
  }
  // Lexically a child of the project; it resolves somewhere else entirely,
  // which is why the containment check runs on the realpath.
  const result = await fileDiff(dir, 'looks-local.txt')
  assert.ok('error' in result, 'a symlink out of the project was read')
})

// ── Reading a real working tree ─────────────────────────────────────

test('modified and untracked files are both listed', async (t) => {
  if (!hasGit) return t.skip('git is not installed')
  const changes = await workingTreeChanges(makeRepo('listing'))
  assert.equal(changes.repo, true)
  assert.equal(changes.truncated, false)

  const byPath = new Map(changes.files.map((f) => [f.path, f]))
  assert.equal(byPath.get('tracked.txt')?.status, 'modified')
  // An agent creating a new file is the common case, so untracked has to appear.
  assert.equal(byPath.get('fresh.txt')?.status, 'untracked')
})

test('an untracked file is shown as an all-added block', async (t) => {
  if (!hasGit) return t.skip('git is not installed')
  const dir = makeRepo('untracked')
  const result = await fileDiff(dir, 'fresh.txt')
  assert.ok(!('error' in result))
  const text = (result as { text: string }).text
  assert.match(text, /^--- \/dev\/null/m)
  assert.match(text, /^\+brand new$/m)
})

test('a file with a name git would read as pathspec magic is still just a file', async (t) => {
  if (!hasGit) return t.skip('git is not installed')
  const dir = makeRepo('pathspec')
  // Without --literal-pathspecs this is `:(exclude)` magic rather than a name.
  const odd = ':(exclude)notes.txt'
  try {
    fs.writeFileSync(path.join(dir, odd), 'literal\n')
  } catch {
    return t.skip('this filesystem does not allow that name')
  }
  const result = await fileDiff(dir, odd)
  assert.ok(!('error' in result), 'the name was interpreted rather than read')
  assert.match((result as { text: string }).text, /\+literal/)
})

// ── Parsing, bounds and labels ──────────────────────────────────────

test('porcelain output is parsed NUL-separated, so a newline in a name survives', () => {
  const files = parseStatus(' M src/a.ts\0?? new file.txt\0A  added.ts\0')
  assert.deepEqual(
    files.map((f) => [f.path, f.status, f.staged]),
    [
      ['src/a.ts', 'modified', false],
      ['new file.txt', 'untracked', false],
      ['added.ts', 'added', true]
    ]
  )
})

test('every status pair maps to something a person reads', () => {
  assert.equal(statusFromCode('?', '?'), 'untracked')
  assert.equal(statusFromCode('U', 'U'), 'conflicted')
  assert.equal(statusFromCode('A', 'A'), 'conflicted')
  assert.equal(statusFromCode('R', ' '), 'renamed')
  assert.equal(statusFromCode(' ', 'D'), 'deleted')
  assert.equal(statusFromCode('A', ' '), 'added')
  assert.equal(statusFromCode(' ', 'M'), 'modified')
})

test('truncation cuts on a line boundary and says that it happened', () => {
  const text = 'aaaa\nbbbb\ncccc\n'
  const capped = capText(text, 7)
  assert.equal(capped.truncated, true)
  assert.equal(capped.text, 'aaaa', 'a diff must not end mid-line')
  assert.deepEqual(capText(text, 1000), { text, truncated: false })
})

test('THE CAP IS IN BYTES: multi-byte text is not silently kept whole', () => {
  // A length check against a byte constant lets a file of CJK or emoji through
  // at three times the budget, and reports that nothing was cut.
  const text = 'a-longer-line-of-text\n'.replace(/a/g, 'あ').repeat(50)
  assert.ok(Buffer.byteLength(text, 'utf8') > text.length, 'the fixture is multi-byte')

  const capped = capText(text, 400)
  assert.equal(capped.truncated, true, 'a byte budget was measured in characters')
  assert.ok(Buffer.byteLength(capped.text, 'utf8') <= 400)
  assert.equal(capped.text.includes('\ufffd'), false, 'cut mid-codepoint')
})

test('a binary untracked file reports itself rather than printing bytes', () => {
  const withNul = Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x01])
  assert.equal(untrackedDiff(withNul, 'logo.png').binary, true)
  assert.equal(untrackedDiff(withNul, 'logo.png').text, '')
})

test('diff line tones read the header lines before the +/- ones', () => {
  // `+++` and `---` start with the same character as the lines they must not be
  // confused with, and every unified diff opens with a pair of them.
  assert.equal(diffLineTone('+++ b/src/a.ts'), 'meta')
  assert.equal(diffLineTone('--- a/src/a.ts'), 'meta')
  assert.equal(diffLineTone('@@ -1,3 +1,3 @@'), 'hunk')
  assert.equal(diffLineTone('+added'), 'add')
  assert.equal(diffLineTone('-removed'), 'del')
  assert.equal(diffLineTone(' context'), '')
})

test('a long path keeps its end, which is the part being read', () => {
  assert.equal(shortPath('src/a.ts'), 'src/a.ts')
  const long = 'packages/app/src/components/really/deep/Component.tsx'
  const short = shortPath(long, 30)
  assert.ok(short.length <= 31, short)
  assert.ok(short.endsWith('Component.tsx'), short)
  assert.ok(short.startsWith('…/'), short)
})

test('status labels stay one character wide', () => {
  for (const status of ['modified', 'added', 'deleted', 'untracked', 'renamed', 'conflicted'] as const) {
    assert.equal(statusLabel(status).length, 1, status)
  }
})
