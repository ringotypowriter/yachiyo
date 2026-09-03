import assert from 'node:assert/strict'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'

import { resolveThreadWorkspacePath, resolveYachiyoTempWorkspaceRoot } from './paths.ts'

function isInsideTempRoot(path: string): boolean {
  // Not a string prefix check: the separator differs by platform, and a
  // prefix would also accept a sibling directory whose name merely starts
  // with the root's.
  const step = relative(resolve(resolveYachiyoTempWorkspaceRoot()), resolve(path))
  return step.length > 0 && !isAbsolute(step) && !step.split(/[\\/]/).includes('..')
}

test('an ordinary thread id resolves under the temp workspace root', () => {
  const threadId = '9f0b6f0e-6b7a-4c67-9f6a-2b4b0f1f2a3c'
  const path = resolveThreadWorkspacePath(threadId)

  assert.equal(path, join(resolveYachiyoTempWorkspaceRoot(), threadId))
  assert.equal(isInsideTempRoot(path), true)
})

test('a thread id that walks out of the temp workspace root is refused', () => {
  // Thread rows arrive from peers over sync and their ids are not validated
  // there, so this is the sink's own job: a path is derived from a string the
  // local device never chose.
  for (const threadId of ['..', '../escape', '../../../../etc/passwd', 'a/../..']) {
    assert.throws(
      () => resolveThreadWorkspacePath(threadId),
      /thread id/i,
      `must refuse a traversing thread id: ${threadId}`
    )
  }
})

test('a thread id carrying a path separator is refused', () => {
  // Even without traversal, a separator silently nests the workspace somewhere
  // the caller did not intend — and on Windows a backslash does the same.
  for (const threadId of ['nested/thread', 'nested\\thread', '/absolute', 'trailing/']) {
    assert.throws(
      () => resolveThreadWorkspacePath(threadId),
      /thread id/i,
      `must refuse a separator in a thread id: ${threadId}`
    )
  }
})

test('an empty or NUL-bearing thread id is refused', () => {
  // An empty id resolves to the root itself, which would let one thread's
  // cleanup reach every thread's workspace.
  for (const threadId of ['', '   ', 'nul\u0000byte', '.']) {
    assert.throws(
      () => resolveThreadWorkspacePath(threadId),
      /thread id/i,
      `must refuse a degenerate thread id: ${JSON.stringify(threadId)}`
    )
  }
})

test('ids that are merely unusual are still accepted', () => {
  // The contract is "cannot leave the root", not "must be a UUID": legacy ids
  // predate the current generator and rejecting them would break real threads.
  for (const threadId of [
    'legacy_thread_1',
    'thread.with.dots',
    '..dotted',
    'unicode-\u00fc',
    'han-\ud55c'
  ]) {
    assert.equal(isInsideTempRoot(resolveThreadWorkspacePath(threadId)), true, threadId)
  }
})
