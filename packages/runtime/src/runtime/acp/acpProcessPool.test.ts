import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { AcpProcessPool, IDLE_TTL_MS, SIGTERM_TIMEOUT_MS } from './acpProcessPool.ts'
import type { AcpProcessPoolKey } from './acpProcessPool.ts'
import type { AcpWarmSession } from './acpSessionClient.ts'

function makeResult(overrides?: Partial<AcpWarmSession>): AcpWarmSession & {
  resolve: () => void
  signals: NodeJS.Signals[]
} {
  let resolveExited!: () => void
  const procExited = new Promise<void>((res) => {
    resolveExited = res
  })

  const signals: NodeJS.Signals[] = []
  const proc = {
    pid: undefined, // no real PID — forces fallback to proc.kill()
    kill: (signal?: NodeJS.Signals | number) => {
      signals.push((signal as NodeJS.Signals) ?? 'SIGTERM')
      return true
    },
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
    signals,
    ...overrides
  }
}

function makeKey(threadId: string, sessionKey: string): AcpProcessPoolKey {
  return { threadId, sessionKey }
}

test('AcpProcessPool checkout returns null when empty', () => {
  const pool = new AcpProcessPool()
  assert.equal(pool.checkout(makeKey('thread-1', 'session-1')), null)
})

test('AcpProcessPool checkout returns and removes idle entry', () => {
  const pool = new AcpProcessPool()
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

  const pool = new AcpProcessPool()
  const result = makeResult()
  const key = makeKey('thread-1', 'session-1')
  pool.checkin(key, result)

  pool.checkout(key)

  // Advance past idle TTL — no kill should happen because timer was cleared
  clock.tick(IDLE_TTL_MS + 100)
  await Promise.resolve() // flush microtasks
  assert.deepEqual(result.signals, [], 'no kill signal after checkout cleared the timer')
})

test('AcpProcessPool evicts with SIGTERM then SIGKILL on timeout', async (t) => {
  const clock = t.mock.timers
  clock.enable({ apis: ['setTimeout'] })

  const pool = new AcpProcessPool()
  const result = makeResult()
  const key = makeKey('thread-1', 'session-1')
  pool.checkin(key, result)

  const evictPromise = pool.evict(key)

  // Process hasn't exited yet — SIGTERM should have been sent
  assert.deepEqual(result.signals, ['SIGTERM'])

  // Advance past SIGTERM timeout — SIGKILL should fire
  clock.tick(SIGTERM_TIMEOUT_MS + 100)
  await Promise.resolve()

  assert.ok(result.signals.includes('SIGKILL'), 'should send SIGKILL after timeout')

  // Resolve process and settle
  result.resolve()
  await evictPromise
})

test('AcpProcessPool evict does not SIGKILL if process exits before timeout', async (t) => {
  const clock = t.mock.timers
  clock.enable({ apis: ['setTimeout'] })

  const pool = new AcpProcessPool()
  const result = makeResult()
  const key = makeKey('thread-1', 'session-1')
  pool.checkin(key, result)

  const evictPromise = pool.evict(key)
  assert.deepEqual(result.signals, ['SIGTERM'])

  // Process exits before the SIGKILL timer fires
  result.resolve()
  await evictPromise

  // Advance past the timeout — no further signals
  clock.tick(SIGTERM_TIMEOUT_MS + 100)
  await Promise.resolve()
  assert.deepEqual(result.signals, ['SIGTERM'], 'only SIGTERM, no SIGKILL')
})

test('AcpProcessPool shutdown drains all idle entries', async () => {
  const pool = new AcpProcessPool()
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
  assert.ok(r1.signals.includes('SIGTERM'))
  assert.ok(r2.signals.includes('SIGTERM'))
})

test('AcpProcessPool auto-evicts when process exits on its own while idle', async () => {
  const pool = new AcpProcessPool()
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

  const pool = new AcpProcessPool()
  const old = makeResult()
  const fresh = makeResult()

  const key = makeKey('thread-1', 'session-1')
  pool.checkin(key, old)
  old.resolve() // old process resolves immediately

  // Re-checkin with a new result — should kill the old one
  pool.checkin(key, fresh)

  assert.ok(old.signals.includes('SIGTERM'), 'old process received SIGTERM on replacement')

  const out = pool.checkout(key)
  assert.equal(out?.proc, fresh.proc, 'pool holds the fresh process')

  clock.tick(0)
  fresh.resolve()
})

test('AcpProcessPool syncKillAll sends SIGKILL to all entries', () => {
  const pool = new AcpProcessPool()
  const r1 = makeResult()
  const r2 = makeResult()
  pool.checkin(makeKey('thread-1', 'session-1'), r1)
  pool.checkin(makeKey('thread-2', 'session-2'), r2)

  pool.syncKillAll()

  assert.ok(r1.signals.includes('SIGKILL'))
  assert.ok(r2.signals.includes('SIGKILL'))
  assert.equal(pool.checkout(makeKey('thread-1', 'session-1')), null)
  assert.equal(pool.checkout(makeKey('thread-2', 'session-2')), null)
})

test('AcpProcessPool keeps idle entries isolated by session key', () => {
  const pool = new AcpProcessPool()
  const result = makeResult()
  const firstKey = makeKey('thread-1', 'profile-old')
  const secondKey = makeKey('thread-1', 'profile-new')

  pool.checkin(firstKey, result)

  assert.equal(pool.checkout(secondKey), null)
  assert.equal(pool.checkout(firstKey)?.proc, result.proc)
})

test('AcpProcessPool evictThread removes every idle entry for the archived thread', async () => {
  const pool = new AcpProcessPool()
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
