import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isListProjectFilesAllowed } from '../electron/main/ipc/files'

/**
 * The containment check behind gronk:list-project-files.
 *
 * It decides which directory the renderer may enumerate, so the interesting
 * cases are the ones where a path only looks contained: a sibling sharing a
 * name prefix, and a symlink. Both sides are canonicalised before comparing,
 * which is what makes a symlinked project match itself and what stops a link
 * inside the project from reaching out of it.
 *
 * Real directories on disk throughout, because realpath is half of what is
 * under test and it has nothing to say about paths that were never created.
 */

const tempDirs: string[] = []

function scratch(prefix: string): string {
  // realpath the temp root: on macOS os.tmpdir() is /var/folders/... which
  // really lives under /private, and a test that compared the two forms would
  // be exercising that quirk rather than the case it means to.
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix))
  tempDirs.push(dir)
  return dir
}

function mkdir(...parts: string[]): string {
  const dir = path.join(...parts)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Link `linkPath` at `target`, or report that this machine will not allow it.
 *
 * A plain directory symlink needs elevation or developer mode on Windows, so
 * the fallback is a junction: the same indirection for directories, created by
 * an unprivileged process, and resolved by realpath exactly the same way. That
 * keeps these cases running on a normal Windows checkout instead of skipping
 * there permanently, which is the state where a symlink regression ships.
 */
function linkDir(target: string, linkPath: string): boolean {
  for (const type of ['dir', 'junction'] as const) {
    try {
      fs.symlinkSync(target, linkPath, type)
      return true
    } catch {
      /* try the next form */
    }
  }
  return false
}

test.after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
})

test('the active project itself is listable', () => {
  const project = scratch('gronk-files-')
  assert.equal(isListProjectFilesAllowed(project, project), true)
})

test('a directory inside the active project is listable', () => {
  const project = scratch('gronk-files-')
  const nested = mkdir(project, 'src', 'components')

  assert.equal(isListProjectFilesAllowed(nested, project), true)
})

test('a subdirectory that does not exist yet is still listable', () => {
  const project = scratch('gronk-files-')

  // realpath cannot resolve what is not there, so this path is compared
  // lexically. Refusing it would break listing a folder the user is creating.
  assert.equal(isListProjectFilesAllowed(path.join(project, 'not-created'), project), true)
})

test('a directory outside the active project is refused', () => {
  const project = scratch('gronk-files-')
  const elsewhere = scratch('gronk-other-')

  assert.equal(isListProjectFilesAllowed(elsewhere, project), false)
})

test('the parent of the active project is refused', () => {
  const parent = scratch('gronk-files-')
  const project = mkdir(parent, 'project')

  assert.equal(isListProjectFilesAllowed(parent, project), false)
})

test('a sibling whose name starts with the project name is refused', () => {
  const home = scratch('gronk-files-')
  const project = mkdir(home, 'project')
  const secrets = mkdir(home, 'project-secrets')

  // The classic prefix bug. Without a separator between the root and the rest,
  // "project-secrets".startsWith("project") makes an unrelated sibling look
  // like a child, and its whole file listing leaves the process.
  assert.equal(isListProjectFilesAllowed(secrets, project), false)
  assert.equal(isListProjectFilesAllowed(path.join(secrets, 'keys'), project), false)
})

test('a project reached through a symlinked root is listable', (t) => {
  const home = scratch('gronk-files-')
  const real = mkdir(home, 'real-project')
  mkdir(real, 'src')
  const linked = path.join(home, 'linked-project')

  if (!linkDir(real, linked)) {
    // Skipping is honest; silently passing would claim coverage that never ran.
    t.skip('neither a symlink nor a junction could be created on this machine')
    return
  }

  // Same directory by two names. Whichever side the link is on, the comparison
  // only succeeds once both are resolved, and this is the shape that a macOS
  // temp dir or a home directory behind a link produces in the real app.
  assert.equal(isListProjectFilesAllowed(path.join(linked, 'src'), real), true)
  assert.equal(isListProjectFilesAllowed(path.join(real, 'src'), linked), true)
  assert.equal(isListProjectFilesAllowed(linked, real), true)
})

test('a symlink inside the project cannot reach outside it', (t) => {
  const project = scratch('gronk-files-')
  const outside = scratch('gronk-other-')
  const escape = path.join(project, 'escape')

  if (!linkDir(outside, escape)) {
    t.skip('neither a symlink nor a junction could be created on this machine')
    return
  }

  // Lexically this path is inside the project, and that is precisely why
  // resolving it matters: the raw string test accepted it and would have listed
  // an unrelated directory. Canonicalising both sides is what refuses it, so
  // this test is the guard against the fix being rolled back into a string
  // compare for looking simpler.
  assert.equal(isListProjectFilesAllowed(escape, project), false)
})

test('listing is unrestricted when no agent session is open', () => {
  const anywhere = scratch('gronk-other-')

  // Pinning a deliberate decision, not a bug. Gronk browses the filesystem
  // before a project is opened, so there is no cwd to confine the picker and
  // the drop-to-open flow to, and refusing here would stop a project being
  // opened at all. Asserted so that tightening it later shows up as a failing
  // test to argue with rather than a silent change in what the renderer may
  // enumerate.
  assert.equal(isListProjectFilesAllowed(anywhere, null), true)
  assert.equal(isListProjectFilesAllowed(os.homedir(), null), true)
})

test('the check folds case and accepts either separator on Windows', (t) => {
  if (process.platform !== 'win32') {
    // Both are case-sensitive facts about win32 paths. On POSIX a backslash is
    // an ordinary filename character and case matters, so asserting either here
    // would be asserting the opposite behaviour.
    t.skip('win32-only path semantics')
    return
  }
  const project = scratch('gronk-files-')
  const nested = mkdir(project, 'src')

  assert.equal(isListProjectFilesAllowed(nested.toUpperCase(), project), true)
  assert.equal(isListProjectFilesAllowed(nested.replace(/\\/g, '/'), project), true)
})
