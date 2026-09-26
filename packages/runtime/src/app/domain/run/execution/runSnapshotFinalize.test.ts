import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { hashWorkspacePath } from '../../../../services/fileSnapshot/casStore.ts'
import { expireRunSnapshots } from './runSnapshotFinalize.ts'

test('expiring run snapshots clears the file counts of exactly the runs retention removed', async () => {
  const originalHome = process.env['YACHIYO_HOME']
  const tempDir = await mkdtemp(join(tmpdir(), 'run-snapshot-expire-test-'))
  process.env['YACHIYO_HOME'] = tempDir
  try {
    const workspacePath = join(tempDir, 'workspace')
    const workspaceHash = hashWorkspacePath(workspacePath)
    const snapshotsDir = join(tempDir, 'file-history', workspaceHash, 'snapshots')
    await mkdir(snapshotsDir, { recursive: true })
    const day = 24 * 60 * 60 * 1000
    for (const [runId, ageDays] of [
      ['expired-run', 11],
      ['recent-run', 1]
    ] as const) {
      await writeFile(
        join(snapshotsDir, `${runId}.json`),
        JSON.stringify({
          runId,
          threadId: 'thread-1',
          workspacePath,
          createdAt: new Date(Date.now() - ageDays * day).toISOString(),
          entries: []
        })
      )
    }
    const updates: Array<[string, { fileCount: number; workspacePath?: string }]> = []

    await expireRunSnapshots(
      { updateRunSnapshot: (runId, snapshot) => updates.push([runId, snapshot]) },
      workspaceHash,
      workspacePath
    )

    assert.deepEqual(updates, [['expired-run', { fileCount: 0, workspacePath }]])
  } finally {
    if (originalHome === undefined) delete process.env['YACHIYO_HOME']
    else process.env['YACHIYO_HOME'] = originalHome
    await rm(tempDir, { recursive: true, force: true })
  }
})
