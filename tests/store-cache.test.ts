import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { __freshUserData } from './stubs/electron'
import {
  getSettings,
  listSessions,
  renameSession,
  repairStoreOnStartup,
  setSettings,
  upsertSession
} from '../electron/main/store'
import type { SessionInfo } from '../shared/types'

/**
 * The store is read from disk once and then held, and the schema repair happens
 * once at startup rather than inside every read.
 *
 * Why this file exists: a read used to be a full read and parse of the file, and
 * on a store carrying an older schema it also triggered a full write — the file
 * copied to the backup, a temp file written and fsynced, then renamed. Several
 * hundred megabytes of disk work, per read, at eighteen call sites. That is what
 * put the rename in front of whatever had one of those files open, and because
 * the write that kept failing was the repair, the version on disk never advanced
 * and the next read tried the whole thing again.
 */

let userData: string

beforeEach(() => {
  userData = __freshUserData()
})

const storeFile = () => path.join(userData, 'gronk-store.json')

const session = (id: string): SessionInfo => ({
  id,
  cwd: '/work/alpha',
  title: id,
  createdAt: 1,
  updatedAt: 1,
  surface: 'project'
})

test('A READ DOES NOT RE-READ THE FILE while it is unchanged', () => {
  setSettings({ theme: 'light' })
  assert.equal(getSettings().theme, 'light')

  // Watch the only thing that would prove it: whether the store file is opened
  // again. Asserting on a stale value instead would pass for a cache that never
  // notices the file changing, which is a different and worse design.
  const realRead = fs.readFileSync
  const opened: string[] = []
  ;(fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((
    file: Parameters<typeof fs.readFileSync>[0],
    ...rest: unknown[]
  ) => {
    if (typeof file === 'string' && file === storeFile()) opened.push(file)
    return (realRead as (...a: unknown[]) => unknown)(file, ...rest)
  }) as typeof fs.readFileSync

  try {
    getSettings()
    getSettings()
    getSettings()
  } finally {
    ;(fs as { readFileSync: typeof fs.readFileSync }).readFileSync = realRead
  }

  assert.deepEqual(opened, [], 'the store was read from disk again')
})

test('A READ DOES NOTICE the file changing underneath it', () => {
  setSettings({ theme: 'light' })
  assert.equal(getSettings().theme, 'light')

  // Nothing but this process writes the store in normal use, so this stands in
  // for a torn write, a sync client, or a second instance. Serving the held copy
  // here would mean the app describing something that is not on disk.
  const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
  raw.settings.theme = 'dark'
  fs.writeFileSync(storeFile(), JSON.stringify(raw, null, 2))

  assert.equal(getSettings().theme, 'dark', 'the held copy was served after the file changed')
})

test('a write is what the next read sees, so the cache cannot go stale', () => {
  setSettings({ theme: 'light' })
  setSettings({ theme: 'dark' })
  assert.equal(getSettings().theme, 'dark')
  const onDisk = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
  assert.equal(onDisk.settings.theme, 'dark', 'the file and the held copy agree')
})

test('THE REPAIR RUNS ONCE and a second startup does not rewrite the file', () => {
  // A store from an older build: one session, and a version older than this one.
  fs.writeFileSync(
    storeFile(),
    JSON.stringify({ version: 1, sessions: [session('s1')], transcripts: {}, settings: {} })
  )

  repairStoreOnStartup()
  const afterFirst = fs.statSync(storeFile())
  const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8'))
  assert.ok(raw.version > 1, 'the repair should have stamped the current version')
  assert.equal(raw.sessions.length, 1, 'and it must not lose anything doing it')

  repairStoreOnStartup()
  assert.equal(
    fs.statSync(storeFile()).mtimeMs,
    afterFirst.mtimeMs,
    'a second startup rewrote a file that was already current'
  )
})

test('a store already at this version is not rewritten at startup', () => {
  upsertSession(session('s1'))
  const before = fs.statSync(storeFile())
  repairStoreOnStartup()
  assert.equal(fs.statSync(storeFile()).mtimeMs, before.mtimeMs)
})

/**
 * Everything below is a failure mode the cache introduced, found by review rather
 * than by writing it. Each one is the same shape: behaviour that used to be
 * re-derived by the next read, because every read went to disk.
 */

test('A FALLBACK READ IS NOT HELD, so a transient failure is not latched', () => {
  upsertSession(session('s1'))
  const good = fs.readFileSync(storeFile(), 'utf8')

  // A read that fails while the file is intact — a scanner's lock, a cloud
  // placeholder that would not hydrate. Simulated by making the parse fail, then
  // restoring the real bytes without touching size or mtime.
  const stat = fs.statSync(storeFile())
  fs.writeFileSync(storeFile(), 'x'.repeat(good.length))
  fs.utimesSync(storeFile(), stat.atime, stat.mtime)
  assert.equal(listSessions().length, 0, 'the fixture did not actually break the read')

  fs.writeFileSync(storeFile(), good)
  fs.utimesSync(storeFile(), stat.atime, stat.mtime)

  // Same size, same mtime. If the fallback had been held it would still be
  // served, and the next write would put it on disk over the real thing.
  assert.equal(
    listSessions().length,
    1,
    'a failed read was latched against the intact file and the session is gone'
  )
})

test('A WRITE THAT THROWS DOES NOT LEAVE ITS CHANGE LOOKING SAVED', () => {
  upsertSession(session('s1'))
  const before = fs.readFileSync(storeFile(), 'utf8')

  // Refuse the write at the last step, which is what an EPERM on the rename does.
  const realRename = fs.renameSync
  ;(fs as { renameSync: typeof fs.renameSync }).renameSync = () => {
    const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException
    err.code = 'EPERM'
    throw err
  }
  try {
    assert.throws(() => renameSession('s1', 'A new title'))
  } finally {
    ;(fs as { renameSync: typeof fs.renameSync }).renameSync = realRename
  }

  assert.equal(fs.readFileSync(storeFile(), 'utf8'), before, 'the file should be untouched')
  assert.equal(
    listSessions()[0].title,
    's1',
    'the app went on serving a rename that never reached disk'
  )
})

/**
 * The cache hands the same object to every caller, so a function that mutates it
 * and does not write would leave the app describing something that is not on
 * disk. Every mutating function in the module writes today; this is what stops
 * the next one from not.
 *
 * A source scan rather than a behavioural test, for the same reason
 * `tests/ipc-handler-guard.test.ts` is one: the property is about every function
 * in the file, including ones nobody has written yet.
 */
test('EVERY FUNCTION THAT MUTATES THE STORE ALSO WRITES IT', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = fs.readFileSync(path.join(here, '../electron/main/store.ts'), 'utf8')

  const bodies = src.split(/\n(?=(?:export )?(?:async )?function )/)
  assert.ok(bodies.length > 20, 'the split found no functions, so this test proves nothing')

  const offenders: string[] = []
  for (const body of bodies) {
    const name = /^(?:export )?(?:async )?function (\w+)/.exec(body)?.[1]
    if (!name || name === 'writeStore' || name === 'readStoreFromDisk') continue
    if (!body.includes('readStore()')) continue
    // Assignment into the tree, or a mutating array call on one of its branches.
    const mutation =
      /\bdata\.[\w.[\]]*\s*=/.exec(body) ??
      /\bdata\.\w+(?:\[[^\]]*\])?\.(?:push|splice|sort|unshift|pop|shift)\(/.exec(body) ??
      /\bdelete data\./.exec(body)
    if (!mutation) continue

    const writeAt = body.indexOf('writeStore(')
    if (writeAt < 0) {
      offenders.push(name)
      continue
    }
    // Mentioning writeStore somewhere is not enough, and the first version of
    // this test made exactly that mistake. `setRecentProjectPinned` mutated the
    // shared store and then returned early when the folder was not found, so the
    // held copy kept a list that never reached disk — and this scan passed it,
    // because the word appeared further down. A return between the mutation and
    // the write is that shape.
    if (/\breturn\b/.test(body.slice(mutation.index, writeAt))) {
      offenders.push(`${name} (returns between mutating and writing)`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these can mutate the held store without writing it: ${offenders.join(', ')}`
  )
})
