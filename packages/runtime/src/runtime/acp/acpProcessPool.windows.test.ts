import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createAcpProcessPool, SIGTERM_TIMEOUT_MS } from './acpProcessPool.ts'

interface ScheduledTimer {
  callback: () => void
  cleared: boolean
  delay: number
  unrefCalled: boolean
  unref(): void
}

test('ACP pool switches from platform graceful termination to force after its timeout', async () => {
  const terminations: Array<{ force: boolean; pid: number }> = []
  const timers: ScheduledTimer[] = []
  const processTree = {
    gracefullyTerminate(pid: number) {
      terminations.push({ force: false, pid })
      return { delivered: true }
    },
    forceTerminate(pid: number) {
      terminations.push({ force: true, pid })
      return { delivered: true }
    }
  }
  const pool = createAcpProcessPool({
    processTree,
    setTimeout: (callback, delay) => {
      const timer: ScheduledTimer = {
        callback,
        cleared: false,
        delay,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true
        }
      }
      timers.push(timer)
      return timer
    },
    clearTimeout: (timer) => {
      timer.cleared = true
    }
  })
  const proc = Object.assign(new EventEmitter(), { pid: 8420 })
  let resolveExited!: () => void
  const procExited = new Promise<void>((resolve) => {
    resolveExited = resolve
  })
  const session = { proc, procExited } as never
  const key = { threadId: 'thread-1', sessionKey: 'agent-1' }

  pool.checkin(key, session)
  const eviction = pool.evict(key)
  await Promise.resolve()

  assert.deepEqual(terminations, [{ force: false, pid: 8420 }])
  const forceTimer = timers.find((timer) => timer.delay === SIGTERM_TIMEOUT_MS)
  assert.ok(forceTimer)
  forceTimer.callback()
  assert.deepEqual(terminations, [
    { force: false, pid: 8420 },
    { force: true, pid: 8420 }
  ])

  resolveExited()
  await eviction
})
