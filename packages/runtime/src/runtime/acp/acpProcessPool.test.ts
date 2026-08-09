import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { AcpProcessPool, IDLE_TTL_MS, SIGTERM_TIMEOUT_MS } from './acpProcessPool.ts'
import type { AcpProcessPoolKey } from './acpProcessPool.ts'
import type { AcpWarmSession } from './acpSessionClient.ts'

interface Termination {
  operation: 'graceful' | 'force'
  pid: number
}

let nextPid = 10_000

function makeResult(overrides?: Partial<AcpWarmSession>): AcpWarmSession & {
  resolve: () => void
} {
  let resolveExited!: () => void
  const procExited = new Promise<void>((res) => {
    resolveExited = res
  })

  const proc = {
    pid: nextPid++,
    kill: () => assert.fail('pool tests must terminate through ProcessTree'),
    stderr: new EventEmitter(),
    stdin: null,
    stdout: null
  } as never

  return {
    proc,
    connection: {} as never,
    sessionId: 'session-test',
    procExited,
    adapterRef: { current: {} as never },
    resolve: resolveExited,
    ...overrides
  }
}

function makePool(): { pool: AcpProcessPool; terminations: Termination[] } {
  const terminations: Termination[] = []
  const pool = new AcpProcessPool({
    processTree: {
      gracefullyTerminate: (pid) => {
        terminations.push({ operation: 'graceful', pid })
        return { delivered: true }
      },
      forceTerminate: (pid) => {
        terminations.push({ operation: 'force', pid })
        return { delivered: true }
      }
    }
  })
  return { pool, terminations }
}

function makeKey(threadId: string, sessionKey: string): AcpProcessPoolKey {
  return { threadId, sessionKey }
}

test('AcpProcessPool checkout returns null when empty', () => {
  const { pool } = makePool()
  assert.equal(pool.checkout(makeKey('thread-1', 'session-1')), null)
})

test('AcpProcessPool checkout returns and removes idle entry', () => {
  const { pool } = makePool()
  const result = makeResult()
  const key = makeKey('thread-1', 'session-1')
  pool.checkin(key, result)

  const out = pool.checkout(key)
  assert.ok(out !== null, 'should return the idle entry')
  assert.equal(out.proc, result.proc)
  // Second checkout should return null — entry was removed
  assert.equal(pool.checkout(key), null)
})

test('AcpProcessPool checkout cancels idle timer', async (t) => {
  const clock = t.mock.timers
  clock.enable({ apis: ['setTimeout'] })

  const { pool, terminations } = makePool()
  const result = makeResult()
  const key = makeKey('thread-1', 'session-1')
  pool.checkin(key, result)

  pool.checkout(key)

  // Advance past idle TTL — no kill should happen because timer was cleared
  clock.tick(IDLE_TTL_MS + 100)
  await Promise.resolve() // flush microtasks
  assert.deepEqual(terminations, [], 'no termination after checkout cleared the timer')
})

test('AcpProcessPool evicts gracefully then force-terminates on timeout', async (t) => {
  const clock = t.mock.timers
  clock.enable({ apis: ['setTimeout'] })

  const { pool, terminations } = makePool()
  const result = makeResult()
  const key = makeKey('thread-1', 'session-1')
  pool.checkin(key, result)

  const evictPromise = pool.evict(key)

  assert.deepEqual(terminations, [{ operation: 'graceful', pid: result.proc.pid }])

  // Advance past the graceful timeout — force termination should fire.
  clock.tick(SIGTERM_TIMEOUT_MS + 100)
  await Promise.resolve()

  assert.deepEqual(terminations, [
    { operation: 'graceful', pid: result.proc.pid },
    { operation: 'force', pid: result.proc.pid }
  ])

  // Resolve process and settle
  result.resolve()
  await evictPromise
})

test('AcpProcessPool evict does not force-terminate if process exits before timeout', async (t) => {
  const clock = t.mock.timers
  clock.enable({ apis: ['setTimeout'] })

  const { pool, terminations } = makePool()
  const result = makeResult()
  const key = makeKey('thread-1', 'session-1')
  pool.checkin(key, result)

  const evictPromise = pool.evict(key)
  assert.deepEqual(terminations, [{ operation: 'graceful', pid: result.proc.pid }])

  // Process exits before the force-termination timer fires.
  result.resolve()
  await evictPromise

  // Advance past the timeout — no further signals
  clock.tick(SIGTERM_TIMEOUT_MS + 100)
  await Promise.resolve()
  assert.deepEqual(terminations, [{ operation: 'graceful', pid: result.proc.pid }])
})

test('AcpProcessPool shutdown drains all idle entries', async () => {
  const { pool, terminations } = makePool()
  const r1 = makeResult()
  const r2 = makeResult()
  pool.checkin(makeKey('thread-1', 'session-1'), r1)
  pool.checkin(makeKey('thread-2', 'session-2'), r2)

  // Resolve processes immediately so shutdown doesn't hang
  r1.resolve()
  r2.resolve()

  await pool.shutdown()

  assert.equal(pool.checkout(makeKey('thread-1', 'session-1')), null)
  assert.equal(pool.checkout(makeKey('thread-2', 'session-2')), null)
  assert.deepEqual(terminations, [
    { operation: 'graceful', pid: r1.proc.pid },
    { operation: 'graceful', pid: r2.proc.pid }
  ])
})

test('AcpProcessPool auto-evicts when process exits on its own while idle', async () => {
  const { pool } = makePool()
  const result = makeResult()
  const key = makeKey('thread-1', 'session-1')
  pool.checkin(key, result)

  // Simulate process self-exit
  result.resolve()
  await Promise.resolve() // allow .then() to run

  assert.equal(pool.checkout(key), null, 'entry removed after self-exit')
})

test('AcpProcessPool replaces existing idle entry on double checkin', async (t) => {
  const clock = t.mock.timers
  clock.enable({ apis: ['setTimeout'] })

  const { pool, terminations } = makePool()
  const old = makeResult()
  const fresh = makeResult()

  const key = makeKey('thread-1', 'session-1')
  pool.checkin(key, old)
  old.resolve() // old process resolves immediately

  // Re-checkin with a new result — should kill the old one
  pool.checkin(key, fresh)

  assert.deepEqual(terminations, [{ operation: 'graceful', pid: old.proc.pid }])

  const out = pool.checkout(key)
  assert.equal(out?.proc, fresh.proc, 'pool holds the fresh process')

  clock.tick(0)
  fresh.resolve()
})

test('AcpProcessPool syncKillAll force-terminates all entries', () => {
  const { pool, terminations } = makePool()
  const r1 = makeResult()
  const r2 = makeResult()
  pool.checkin(makeKey('thread-1', 'session-1'), r1)
  pool.checkin(makeKey('thread-2', 'session-2'), r2)

  pool.syncKillAll()

  assert.deepEqual(terminations, [
    { operation: 'force', pid: r1.proc.pid },
    { operation: 'force', pid: r2.proc.pid }
  ])
  assert.equal(pool.checkout(makeKey('thread-1', 'session-1')), null)
  assert.equal(pool.checkout(makeKey('thread-2', 'session-2')), null)
})

test('AcpProcessPool keeps idle entries isolated by session key', () => {
  const { pool } = makePool()
  const result = makeResult()
  const firstKey = makeKey('thread-1', 'profile-old')
  const secondKey = makeKey('thread-1', 'profile-new')

  pool.checkin(firstKey, result)

  assert.equal(pool.checkout(secondKey), null)
  assert.equal(pool.checkout(firstKey)?.proc, result.proc)
})

test('AcpProcessPool evictThread removes every idle entry for the archived thread', async () => {
  const { pool } = makePool()
  const threadOneA = makeResult()
  const threadOneB = makeResult()
  const threadTwo = makeResult()

  pool.checkin(makeKey('thread-1', 'profile-a'), threadOneA)
  pool.checkin(makeKey('thread-1', 'profile-b'), threadOneB)
  pool.checkin(makeKey('thread-2', 'profile-a'), threadTwo)

  threadOneA.resolve()
  threadOneB.resolve()

  await pool.evictThread('thread-1')

  assert.equal(pool.checkout(makeKey('thread-1', 'profile-a')), null)
  assert.equal(pool.checkout(makeKey('thread-1', 'profile-b')), null)
  assert.equal(pool.checkout(makeKey('thread-2', 'profile-a'))?.proc, threadTwo.proc)
})
