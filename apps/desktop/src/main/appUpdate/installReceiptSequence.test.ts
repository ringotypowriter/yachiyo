import assert from 'node:assert/strict'
import test from 'node:test'

import { runInstallReceiptSequence, type InstallReceiptDeps } from './installReceiptSequence.ts'

const origin = { channelId: 'chan-1', threadId: 'thread-1', messageId: 'msg-1' }

function deps(overrides: Partial<InstallReceiptDeps> = {}): {
  deps: InstallReceiptDeps
  log: string[]
} {
  const log: string[] = []
  const base: InstallReceiptDeps = {
    resolveOrigin: async () => {
      log.push('resolve')
      return origin
    },
    persist: () => {
      log.push('persist')
    },
    clear: () => {
      log.push('clear')
    },
    reserve: () => {
      log.push('reserve')
    },
    announce: async () => {
      log.push('announce')
    },
    announceTimeoutMs: 50,
    now: () => 1_760_000_000_000,
    fromVersion: '1.0.0',
    targetVersion: '1.1.0',
    ...overrides
  }
  return { deps: base, log }
}

/**
 * Acceptance ①, judged by order rather than by presence: the record must be
 * durable and the user must have been told before anything irreversible
 * happens. A notice sent afterwards is not the same promise.
 */
test('persists before reserving and announces only once the slot is held', async () => {
  const { deps: d, log } = deps()
  await runInstallReceiptSequence('run-1', d)
  assert.deepEqual(log, ['resolve', 'persist', 'reserve', 'announce'])
})

/**
 * Reserving can fail — another install may hold the slot. The record was
 * written first, so it has to be removed, or the next start reports a receipt
 * for an update that never began.
 */
test('a failed reservation clears the record and never announces', async () => {
  const { deps: d, log } = deps()
  d.reserve = (): void => {
    log.push('reserve')
    throw new Error('Update is not prepared for installation.')
  }
  await assert.rejects(() => runInstallReceiptSequence('run-1', d), /not prepared/)
  assert.deepEqual(log, ['resolve', 'persist', 'reserve', 'clear'])
  assert.ok(!log.includes('announce'), 'never promise a return for an install that did not start')
})

/**
 * Persisting is the basis of the whole post-restart receipt. Without it the
 * restart is silent, which is the failure this layer exists to remove — so it
 * aborts rather than installing blind.
 */
test('a failed persist aborts before reserving and never announces', async () => {
  const { deps: d, log } = deps({
    persist: () => {
      throw new Error('disk full')
    }
  })
  await assert.rejects(() => runInstallReceiptSequence('run-1', d), /disk full/)
  assert.deepEqual(log, ['resolve'])
})

/**
 * The opening notice is best-effort: losing it costs the user a sentence,
 * while refusing to install costs them the update. The post-restart receipt
 * still closes the loop.
 */
test('a failed announce still installs', async () => {
  const { deps: d, log } = deps({
    announce: async () => {
      throw new Error('network down')
    }
  })
  await runInstallReceiptSequence('run-1', d)
  assert.deepEqual(log, ['resolve', 'persist', 'reserve'])
})

/**
 * A hung send must not stretch the window the reservation holds open. Bounded
 * wait, then continue.
 */
test('a hung announce is abandoned after the bound rather than blocking install', async () => {
  const { deps: d } = deps({
    announceTimeoutMs: 20,
    announce: () => new Promise<void>(() => {})
  })
  const started = Date.now()
  await runInstallReceiptSequence('run-1', d)
  assert.ok(Date.now() - started < 1_000, 'must not wait on a send that never settles')
})

/** A run with no external origin has nobody waiting; skip the whole thing. */
test('a run with no channel origin installs without persisting or announcing', async () => {
  const { deps: d, log } = deps({ resolveOrigin: async () => undefined })
  await runInstallReceiptSequence('run-1', d)
  assert.deepEqual(log, ['reserve'])
})

/** No initiating run at all — a plain terminal invocation. */
test('an install with no initiator reserves directly', async () => {
  const { deps: d, log } = deps()
  await runInstallReceiptSequence(undefined, d)
  assert.deepEqual(log, ['reserve'])
})

test('the persisted record carries what the post-restart receipt needs', async () => {
  let saved: unknown
  const { deps: d } = deps({
    persist: (receipt) => {
      saved = receipt
    }
  })
  await runInstallReceiptSequence('run-1', d)
  assert.deepEqual(saved, {
    channelId: 'chan-1',
    threadId: 'thread-1',
    messageId: 'msg-1',
    fromVersion: '1.0.0',
    targetVersion: '1.1.0',
    startedAtMs: 1_760_000_000_000
  })
})
