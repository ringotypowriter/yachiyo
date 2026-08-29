import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import test from 'node:test'

import { resolveJsReplCallCwd } from './jsReplCwd.ts'

test('accepts a Windows child directory inside the workspace', () => {
  assert.equal(
    resolveJsReplCallCwd('C:\\workspace', 'C:\\workspace\\sub\\deep', win32),
    'C:\\workspace\\sub\\deep'
  )
})

test('rejects Windows siblings and paths on another drive', () => {
  assert.throws(
    () => resolveJsReplCallCwd('C:\\workspace', 'C:\\workspace-other', win32),
    /Invalid cwd/
  )
  assert.throws(
    () => resolveJsReplCallCwd('C:\\workspace', 'D:\\workspace\\sub', win32),
    /Invalid cwd/
  )
})

test('keeps POSIX containment behavior', () => {
  assert.equal(resolveJsReplCallCwd('/workspace', '/workspace/sub', posix), '/workspace/sub')
  assert.throws(() => resolveJsReplCallCwd('/workspace', '/workspace-other', posix), /Invalid cwd/)
})
