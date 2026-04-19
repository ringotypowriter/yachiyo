import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runGc } from './snapshotGc.ts'
import { hashWorkspacePath, storeBlob } from './casStore.ts'

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
    if (originalEnv === undefined) {
      delete process.env['YACHIYO_HOME']
    } else {
      process.env['YACHIYO_HOME'] = originalEnv
    }
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

  await t.test('grace period protects blobs from an in-flight run', async () => {
    // Simulates: Run A has stored a backup blob via trackBeforeWrite but
    // hasn't written its snapshot yet; Run B finishes and triggers GC.
    const workspaceHash = hashWorkspacePath(workspaceDir)
    const backupsDir = join(tempDir, 'file-history', workspaceHash, 'backups')
    const snapshotsDir = join(tempDir, 'file-history', workspaceHash, 'snapshots')
    await mkdir(backupsDir, { recursive: true })
    await mkdir(snapshotsDir, { recursive: true })

    const inFlightHash = await storeBlob(workspaceHash, 'run-A-in-flight\n')

    // Run B's finished snapshot — references nothing of Run A.
    const runBSnapshot = {
      runId: 'run-b',
      threadId: 'thread-b',
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
      entries: []
    }
    await writeFile(join(snapshotsDir, 'run-b.json'), JSON.stringify(runBSnapshot), 'utf8')

    await runGc(workspaceHash)

    const survivingBlobs = await readdir(backupsDir)
    assert.ok(
      survivingBlobs.includes(inFlightHash),
      'in-flight blob must survive GC while still within the grace window'
    )
  })

  await t.test('orphan blobs older than the grace window are still swept', async () => {
    const workspaceHash = hashWorkspacePath(workspaceDir)
    const backupsDir = join(tempDir, 'file-history', workspaceHash, 'backups')
    const snapshotsDir = join(tempDir, 'file-history', workspaceHash, 'snapshots')
    await mkdir(backupsDir, { recursive: true })
    await mkdir(snapshotsDir, { recursive: true })

    const orphanHash = await storeBlob(workspaceHash, 'forgotten\n')
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(join(backupsDir, orphanHash), twoHoursAgo, twoHoursAgo)

    await runGc(workspaceHash)

    const survivingBlobs = await readdir(backupsDir)
    assert.ok(!survivingBlobs.includes(orphanHash), 'aged orphan blob should be swept')
  })
})
