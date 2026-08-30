import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import test from 'node:test'

import { resolveReplCallCwd } from './replCwd.ts'

test('accepts a Windows child directory inside the workspace', () => {
  assert.equal(
    resolveReplCallCwd('C:\\workspace', 'C:\\workspace\\sub\\deep', win32),
    'C:\\workspace\\sub\\deep'
  )
  assert.equal(resolveReplCallCwd('C:\\workspace', 'sub\\deep', win32), 'C:\\workspace\\sub\\deep')
})

test('rejects Windows siblings and paths on another drive', () => {
  assert.throws(
    () => resolveReplCallCwd('C:\\workspace', 'C:\\workspace-other', win32),
    /Invalid cwd/
  )
  assert.throws(
    () => resolveReplCallCwd('C:\\workspace', 'D:\\workspace\\sub', win32),
    /Invalid cwd/
  )
})

test('keeps POSIX containment behavior', () => {
  assert.equal(resolveReplCallCwd('/workspace', '/workspace/sub', posix), '/workspace/sub')
  assert.equal(resolveReplCallCwd('/workspace', 'sub/deep', posix), '/workspace/sub/deep')
  assert.throws(() => resolveReplCallCwd('/workspace', '/workspace-other', posix), /Invalid cwd/)
})
