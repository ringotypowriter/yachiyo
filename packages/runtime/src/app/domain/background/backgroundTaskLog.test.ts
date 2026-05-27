import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readBackgroundTaskLogTail } from './backgroundTaskLog.ts'

test('readBackgroundTaskLogTail returns a bounded tail for large logs', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'bg-task-log-'))
  try {
    const logPath = join(tempDir, 'large.log')
    const oldChunk = 'old output\n'.repeat(200)
    const recentChunk = 'recent output\n'.repeat(20)
    await writeFile(logPath, oldChunk + recentChunk, 'utf8')

    const snapshot = await readBackgroundTaskLogTail(logPath, 128)

    assert.equal(snapshot.truncated, true)
    assert.equal(snapshot.content.includes('old output'), false)
    assert.equal(snapshot.content.endsWith(recentChunk.slice(-128)), true)
    assert.equal(snapshot.content.length <= 128, true)
    assert.equal(snapshot.totalBytes, Buffer.byteLength(oldChunk + recentChunk, 'utf8'))
    assert.equal(snapshot.startByte, snapshot.totalBytes - 128)
  } finally {
    await rm(tempDir, { recursive: true })
  }
})
