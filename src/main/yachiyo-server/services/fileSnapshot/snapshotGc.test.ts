import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runGc } from './snapshotGc.ts'
import { hashWorkspacePath } from './casStore.ts'

const originalEnv = process.env['YACHIYO_HOME']

test('snapshotGc', async (t) => {
  let tempDir: string
  let workspaceDir: string

  t.beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'snapshot-gc-test-'))
    workspaceDir = join(tempDir, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    process.env['YACHIYO_HOME'] = tempDir
  })

  t.afterEach(async () => {
    process.env['YACHIYO_HOME'] = originalEnv
    await rm(tempDir, { recursive: true, force: true })
  })

  await t.test('deletes snapshots older than 7 days even when fewer than 20 exist', async () => {
    const workspaceHash = hashWorkspacePath(workspaceDir)
    const snapshotsDir = join(tempDir, 'file-history', workspaceHash, 'snapshots')
    await mkdir(snapshotsDir, { recursive: true })

    const oldSnapshot = {
      runId: 'old-run',
      threadId: 'thread-1',
      workspacePath: workspaceDir,
      createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      entries: []
    }
    await writeFile(join(snapshotsDir, 'old-run.json'), JSON.stringify(oldSnapshot), 'utf8')

    await runGc(workspaceHash)

    const files = await readdir(snapshotsDir)
    assert.ok(!files.includes('old-run.json'), 'old snapshot should be deleted')
  })

  await t.test('keeps recent snapshots within 7 days', async () => {
    const workspaceHash = hashWorkspacePath(workspaceDir)
    const snapshotsDir = join(tempDir, 'file-history', workspaceHash, 'snapshots')
    await mkdir(snapshotsDir, { recursive: true })

    const recentSnapshot = {
      runId: 'recent-run',
      threadId: 'thread-1',
      workspacePath: workspaceDir,
      createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
      entries: []
    }
    await writeFile(join(snapshotsDir, 'recent-run.json'), JSON.stringify(recentSnapshot), 'utf8')

    await runGc(workspaceHash)

    const files = await readdir(snapshotsDir)
    assert.ok(files.includes('recent-run.json'), 'recent snapshot should be kept')
  })
})
