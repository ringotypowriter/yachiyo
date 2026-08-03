import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readPendingUpdateReceipt } from './pendingUpdateReceipt.ts'

/**
 * Installing an update is not a graceful shutdown — the process is replaced.
 * A record that only survives clean exits would be missing in exactly the
 * situation it was written for, so this kills the writer outright rather than
 * trusting an `exit` hook to have run.
 */
test('a receipt written before SIGKILL is still readable afterwards', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'yachiyo-kill-')), 'pending.json')
  const moduleUrl = new URL('./pendingUpdateReceipt.ts', import.meta.url).href

  // Writes the record, then kills itself with SIGKILL — no cleanup, no flush,
  // no chance to tidy up. Exactly how quitAndInstall ends this process.
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      const { writePendingUpdateReceipt } = await import(${JSON.stringify(moduleUrl)})
      writePendingUpdateReceipt(${JSON.stringify(path)}, {
        channelId: 'chan-1', threadId: 'thread-1', messageId: 'msg-1',
        fromVersion: '1.0.0', targetVersion: '1.1.0', startedAtMs: 1760000000000
      })
      process.kill(process.pid, 'SIGKILL')
      `
    ],
    { encoding: 'utf8' }
  )

  assert.equal(child.signal, 'SIGKILL', `child must have been killed, got: ${child.stderr}`)

  const found = readPendingUpdateReceipt(path, 1_760_000_060_000)
  assert.ok(found, 'the record must outlive the process that wrote it')
  assert.equal(found.targetVersion, '1.1.0')
  assert.equal(found.channelId, 'chan-1')
})
