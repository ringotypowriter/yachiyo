import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bumpThreadMessageAuthority,
  dropPlanDocumentsOfDeletedThreads,
  dropSnapshotsOfDeletedThreads,
  isThreadDeleted,
  resolveThreadReadOutcome
} from './threadMessageAuthority.ts'

test('a read of a thread nobody has synced applies its own result', () => {
  // A thread with no entry at all must not read as changed, or every ordinary
  // open would discard what it just fetched.
  assert.equal(resolveThreadReadOutcome({ captured: undefined, current: undefined }), 'apply')
})

test('a read is stale once the thread it read has been replaced', () => {
  const after = bumpThreadMessageAuthority({}, 'thread-1')

  assert.equal(
    resolveThreadReadOutcome({ captured: undefined, current: after['thread-1'] }),
    'stale'
  )
})

test('a write to one thread does not invalidate reads of another', () => {
  const before = bumpThreadMessageAuthority({}, 'thread-1')
  const after = bumpThreadMessageAuthority(before, 'thread-2')

  assert.equal(
    resolveThreadReadOutcome({ captured: before['thread-1'], current: after['thread-1'] }),
    'apply'
  )
  assert.equal(after['thread-2']?.revision, 1)
})

test('successive replacements keep invalidating', () => {
  let authority = bumpThreadMessageAuthority({}, 'thread-1')
  const captured = authority['thread-1']
  authority = bumpThreadMessageAuthority(authority, 'thread-1')

  assert.equal(resolveThreadReadOutcome({ captured, current: authority['thread-1'] }), 'stale')
})

test('a read issued after the thread was deleted is still refused', () => {
  // The tombstone already existed when this read was dispatched, so it captured
  // and returns the same revision. Comparing revisions alone would call it
  // current and let it repopulate a deleted thread's caches.
  const deleted = bumpThreadMessageAuthority({}, 'thread-1', { deleted: true })
  const entry = deleted['thread-1']

  assert.equal(resolveThreadReadOutcome({ captured: entry, current: entry }), 'deleted')
})

test('deletion outranks a matching revision and a changed one alike', () => {
  const replaced = bumpThreadMessageAuthority({}, 'thread-1')
  const deleted = bumpThreadMessageAuthority(replaced, 'thread-1', { deleted: true })

  assert.equal(
    resolveThreadReadOutcome({ captured: replaced['thread-1'], current: deleted['thread-1'] }),
    'deleted'
  )
})

test('a thread with no entry and a live thread are both not deleted', () => {
  // Callers with no read to date-check ask only this. An unknown thread must
  // not read as deleted, or a first open would be refused.
  const replaced = bumpThreadMessageAuthority({}, 'thread-1')

  assert.equal(isThreadDeleted(undefined), false)
  assert.equal(isThreadDeleted(replaced['thread-1']), false)
  assert.equal(
    isThreadDeleted(
      bumpThreadMessageAuthority(replaced, 'thread-1', { deleted: true })['thread-1']
    ),
    true
  )
})

test("a listing that crossed a deletion loses only that thread's snapshots", () => {
  // The listing was dispatched before the delete, so the response still
  // contains the deleted thread's agents. Folding it back re-creates the
  // per-thread entry the delete cleared.
  const authority = bumpThreadMessageAuthority({}, 'thread-gone', { deleted: true })

  const kept = dropSnapshotsOfDeletedThreads(
    [
      { agentId: 'a1', parentThreadId: 'thread-gone' },
      { agentId: 'a2', parentThreadId: 'thread-live' }
    ],
    authority
  )

  assert.deepEqual(
    kept.map((snapshot) => snapshot.agentId),
    ['a2']
  )
})

test('a listing of threads none of which were deleted passes through', () => {
  const authority = bumpThreadMessageAuthority({}, 'thread-live')

  const kept = dropSnapshotsOfDeletedThreads(
    [{ agentId: 'a1', parentThreadId: 'thread-live' }],
    authority
  )

  assert.equal(kept.length, 1)
})

test('a batch of plan reads keeps only the threads that still exist', () => {
  // Startup reads every pending plan at once; one of those threads can be
  // deleted before the batch lands, and a whole-batch guard would either drop
  // all of them or none.
  const authority = bumpThreadMessageAuthority({}, 'thread-gone', { deleted: true })

  const kept = dropPlanDocumentsOfDeletedThreads(
    [
      ['thread-gone', { path: 'a.md' }],
      ['thread-live', { path: 'b.md' }]
    ],
    authority
  )

  assert.deepEqual(
    kept.map(([threadId]) => threadId),
    ['thread-live']
  )
})
