import test from 'node:test'
import assert from 'node:assert/strict'
import { cachedProbe } from '../electron/main/cache'

/** Controllable clock so TTL behaviour is deterministic. */
function clock(start = 1000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms) }
}

/** A probe that resolves only when released, so overlap can be observed. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('a fresh value is reused without re-running the probe', async () => {
  const c = clock()
  let calls = 0
  const probe = cachedProbe(async () => ++calls, { ttlMs: 1000, now: c.now })

  assert.equal(await probe.get(), 1)
  assert.equal(await probe.get(), 1)
  assert.equal(calls, 1)
})

test('the probe runs again once the value goes stale', async () => {
  const c = clock()
  let calls = 0
  const probe = cachedProbe(async () => ++calls, { ttlMs: 1000, now: c.now })

  await probe.get()
  c.advance(999)
  await probe.get()
  assert.equal(calls, 1, 'still fresh at ttl-1')

  c.advance(1)
  assert.equal(await probe.get(), 2, 'stale at exactly ttl')
  assert.equal(calls, 2)
})

// The startup path runs its probes inside one Promise.all, so they overlap.
// This is what collapses three concurrent `grok models` spawns into one.
test('concurrent callers share a single execution', async () => {
  const c = clock()
  const gate = deferred<string>()
  let calls = 0
  const probe = cachedProbe(
    () => {
      calls++
      return gate.promise
    },
    { ttlMs: 1000, now: c.now }
  )

  const all = Promise.all([probe.get(), probe.get(), probe.get()])
  gate.resolve('ok')

  assert.deepEqual(await all, ['ok', 'ok', 'ok'])
  assert.equal(calls, 1, 'three overlapping callers must spawn one probe')
})

test('invalidate forces the next call to re-run', async () => {
  const c = clock()
  let calls = 0
  const probe = cachedProbe(async () => ++calls, { ttlMs: 10_000, now: c.now })

  await probe.get()
  probe.invalidate()
  assert.equal(await probe.get(), 2)
  assert.equal(calls, 2)
})

// A transient network failure must not pin an error for the whole TTL.
test('a rejection is never cached', async () => {
  const c = clock()
  let calls = 0
  const probe = cachedProbe(
    async () => {
      calls++
      if (calls === 1) throw new Error('offline')
      return 'recovered'
    },
    { ttlMs: 10_000, now: c.now }
  )

  await assert.rejects(() => probe.get(), /offline/)
  assert.equal(await probe.get(), 'recovered', 'must retry immediately after a failure')
})

// Without clearing the in-flight slot in a `finally`, one failed probe would
// wedge every later caller onto the same dead promise.
test('a failed probe does not wedge later callers', async () => {
  const c = clock()
  const gate = deferred<string>()
  let calls = 0
  const probe = cachedProbe(
    () => {
      calls++
      return calls === 1 ? gate.promise : Promise.resolve('second')
    },
    { ttlMs: 10_000, now: c.now }
  )

  const first = probe.get()
  gate.reject(new Error('boom'))
  await assert.rejects(() => first, /boom/)

  assert.equal(await probe.get(), 'second')
  assert.equal(calls, 2)
})

test('concurrent callers during a failure still produce one attempt', async () => {
  const c = clock()
  const gate = deferred<string>()
  let calls = 0
  const probe = cachedProbe(
    () => {
      calls++
      return gate.promise
    },
    { ttlMs: 10_000, now: c.now }
  )

  const a = probe.get()
  const b = probe.get()
  gate.reject(new Error('outage'))
  await assert.rejects(() => a, /outage/)
  await assert.rejects(() => b, /outage/)
  assert.equal(calls, 1)
})

test('a zero ttl still de-duplicates concurrent callers', async () => {
  const c = clock()
  const gate = deferred<number>()
  let calls = 0
  const probe = cachedProbe(
    () => {
      calls++
      return gate.promise
    },
    { ttlMs: 0, now: c.now }
  )

  const all = Promise.all([probe.get(), probe.get()])
  gate.resolve(7)
  assert.deepEqual(await all, [7, 7])
  assert.equal(calls, 1)

  // ...but never serves a stale value afterwards.
  await probe.get()
  assert.equal(calls, 2)
})
