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
  writeFileSync(path, JSON.stringify({ channelId: 'chan-1' }))
  assert.equal(readPendingUpdateReceipt(path, Date.now()), undefined)
})
