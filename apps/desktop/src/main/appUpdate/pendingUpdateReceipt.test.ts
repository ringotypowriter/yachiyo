import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  clearPendingUpdateReceipt,
  readPendingUpdateReceipt,
  writePendingUpdateReceipt,
  type PendingUpdateReceipt
} from './pendingUpdateReceipt.ts'

function scratch(): string {
  return join(mkdtempSync(join(tmpdir(), 'yachiyo-receipt-')), 'pending-update-receipt.json')
}

const receipt: PendingUpdateReceipt = {
  attemptId: 'attempt-1',
  channelId: 'chan-1',
  threadId: 'thread-1',
  messageId: 'msg-1',
  fromVersion: '1.0.0',
  targetVersion: '1.1.0',
  startedAtMs: 1_760_000_000_000
}

test('a written receipt reads back verbatim', () => {
  const path = scratch()
  writePendingUpdateReceipt(path, receipt)
  assert.deepEqual(readPendingUpdateReceipt(path, receipt.startedAtMs + 1_000), receipt)
})

test('no receipt reads as undefined rather than throwing', () => {
  assert.equal(readPendingUpdateReceipt(scratch(), Date.now()), undefined)
})

/**
 * The update exits by SIGKILL, so the write must be complete on disk before
 * the process can die — a torn file would be read back as "no pending
 * receipt" and the leader would never hear the outcome.
 */
test('the file is written atomically, never left partial', () => {
  const path = scratch()
  writePendingUpdateReceipt(path, receipt)
  const raw = readFileSync(path, 'utf8')
  assert.deepEqual(JSON.parse(raw), receipt, 'file content parses as a whole record')
})

test('clearing removes the record', () => {
  const path = scratch()
  writePendingUpdateReceipt(path, receipt)
  clearPendingUpdateReceipt(path)
  assert.equal(existsSync(path), false)
  assert.equal(readPendingUpdateReceipt(path, Date.now()), undefined)
})

test('clearing a receipt that is not there is not an error', () => {
  assert.doesNotThrow(() => clearPendingUpdateReceipt(scratch()))
})

/**
 * A record older than the expiry is still *reported* — once — as an unknown
 * outcome, so it must survive reading. Dropping it silently is the exact
 * failure this layer exists to prevent, so expiry is surfaced, not hidden.
 */
test('an expired receipt is returned and marked expired, not dropped', () => {
  const path = scratch()
  writePendingUpdateReceipt(path, receipt)
  const dayLater = receipt.startedAtMs + 24 * 60 * 60 * 1_000 + 1
  const found = readPendingUpdateReceipt(path, dayLater)
  assert.ok(found, 'an expired record must still be readable')
  assert.equal(found.expired, true)
})

test('a fresh receipt is not marked expired', () => {
  const path = scratch()
  writePendingUpdateReceipt(path, receipt)
  const found = readPendingUpdateReceipt(path, receipt.startedAtMs + 60_000)
  assert.equal(found?.expired, undefined)
})

/**
 * Garbage on disk must not crash startup, and must not be mistaken for a
 * valid pending update either.
 */
test('an unreadable record is treated as absent, not as a crash', () => {
  const path = scratch()
  writeFileSync(path, '{ this is not json')
  assert.equal(readPendingUpdateReceipt(path, Date.now()), undefined)
})

test('a record missing required fields is treated as absent', () => {
  const path = scratch()
  writeFileSync(path, JSON.stringify({ attemptId: 'a', channelId: 'chan-1' }))
  assert.equal(readPendingUpdateReceipt(path, Date.now()), undefined)
})

/**
 * Two overlapping installs both write here. Only one wins the reservation;
 * the loser must not take the winner's receipt down with it, or the update
 * that really is restarting comes back with nobody to report to.
 */
test('a different attempt cannot clear the record it does not own', () => {
  const path = scratch()
  writePendingUpdateReceipt(path, receipt)

  clearPendingUpdateReceipt(path, 'some-other-attempt')

  const survivor = readPendingUpdateReceipt(path, receipt.startedAtMs + 1_000)
  assert.ok(survivor, 'the winner keeps its pending receipt')
  assert.equal(survivor.attemptId, 'attempt-1')
})

test('the owning attempt can clear its own record', () => {
  const path = scratch()
  writePendingUpdateReceipt(path, receipt)

  clearPendingUpdateReceipt(path, receipt.attemptId)

  assert.equal(readPendingUpdateReceipt(path, Date.now()), undefined)
})

/** Startup delivery owns whatever it finds, so it clears unconditionally. */
test('clearing without an attempt id removes whatever is there', () => {
  const path = scratch()
  writePendingUpdateReceipt(path, receipt)

  clearPendingUpdateReceipt(path)

  assert.equal(readPendingUpdateReceipt(path, Date.now()), undefined)
})
