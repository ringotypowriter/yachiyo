import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { SnapshotTracker } from './snapshotTracker.ts'
import { readBlob } from './casStore.ts'

const originalEnv = process.env['YACHIYO_HOME']

test('SnapshotTracker', async (t) => {
  let tempDir: string
  let workspaceDir: string

  t.beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'snapshot-tracker-test-'))
    workspaceDir = join(tempDir, 'workspace')
    await mkdir(workspaceDir, { recursive: true })
    process.env['YACHIYO_HOME'] = tempDir
  })

  t.afterEach(async () => {
    process.env['YACHIYO_HOME'] = originalEnv
    await rm(tempDir, { recursive: true, force: true })
  })

  await t.test('trackBeforeWrite stores existing file in CAS', async () => {
    const filePath = join(workspaceDir, 'existing.txt')
    await writeFile(filePath, 'original content')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    await tracker.trackBeforeWrite(filePath)

    assert.equal(tracker.hasTrackedFiles, true)

    // Modify the file before finalizing to ensure it shows in the snapshot
    await writeFile(filePath, 'modified content')

    const snapshot = await tracker.finalize()
    assert.equal(snapshot.entries.length, 1)
    assert.equal(snapshot.entries[0]!.relativePath, 'existing.txt')
    assert.ok(snapshot.entries[0]!.backupHash)

    const blob = await readBlob(tracker.workspaceHash, snapshot.entries[0]!.backupHash!)
    assert.equal(blob.toString('utf8'), 'original content')

    tracker.dispose()
  })

  await t.test('trackBeforeWrite records null hash for new files', async () => {
    const filePath = join(workspaceDir, 'new-file.txt')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    await tracker.trackBeforeWrite(filePath)

    // Create the file so it appears in finalize
    await writeFile(filePath, 'new content')

    const snapshot = await tracker.finalize()
    assert.equal(snapshot.entries.length, 1)
    assert.equal(snapshot.entries[0]!.backupHash, null)
    assert.equal(snapshot.entries[0]!.originalSize, 0)

    tracker.dispose()
  })

  await t.test('trackBeforeWrite is idempotent', async () => {
    const filePath = join(workspaceDir, 'file.txt')
    await writeFile(filePath, 'content v1')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    await tracker.trackBeforeWrite(filePath)

    // Modify the file
    await writeFile(filePath, 'content v2')

    // Track again — should be a no-op, still keeping v1
    await tracker.trackBeforeWrite(filePath)

    const snapshot = await tracker.finalize()
    assert.equal(snapshot.entries.length, 1)

    const blob = await readBlob(tracker.workspaceHash, snapshot.entries[0]!.backupHash!)
    assert.equal(blob.toString('utf8'), 'content v1')

    tracker.dispose()
  })

  await t.test('finalize produces sorted, deterministic entries', async () => {
    await writeFile(join(workspaceDir, 'z-file.txt'), 'z')
    await writeFile(join(workspaceDir, 'a-file.txt'), 'a')
    await writeFile(join(workspaceDir, 'm-file.txt'), 'm')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    await tracker.trackBeforeWrite(join(workspaceDir, 'z-file.txt'))
    await tracker.trackBeforeWrite(join(workspaceDir, 'a-file.txt'))
    await tracker.trackBeforeWrite(join(workspaceDir, 'm-file.txt'))

    // Modify all files so they appear in finalize
    await writeFile(join(workspaceDir, 'z-file.txt'), 'z2')
    await writeFile(join(workspaceDir, 'a-file.txt'), 'a2')
    await writeFile(join(workspaceDir, 'm-file.txt'), 'm2')

    const snapshot = await tracker.finalize()
    assert.deepEqual(
      snapshot.entries.map((e) => e.relativePath),
      ['a-file.txt', 'm-file.txt', 'z-file.txt']
    )

    tracker.dispose()
  })

  await t.test('finalize persists and can be loaded', async () => {
    await writeFile(join(workspaceDir, 'file.txt'), 'hello')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    await tracker.trackBeforeWrite(join(workspaceDir, 'file.txt'))

    // Modify so it shows in snapshot
    await writeFile(join(workspaceDir, 'file.txt'), 'changed')
    await tracker.finalize()

    const loaded = await SnapshotTracker.loadSnapshot(tracker.workspaceHash, 'run-1')
    assert.ok(loaded)
    assert.equal(loaded.runId, 'run-1')
    assert.equal(loaded.entries.length, 1)

    tracker.dispose()
  })

  await t.test('empty tracker produces empty snapshot', async () => {
    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    tracker.dispose()
    const snapshot = await tracker.finalize()
    assert.equal(snapshot.entries.length, 0)
    assert.equal(tracker.hasTrackedFiles, false)
  })

  await t.test('finalize excludes unchanged baselined files', async () => {
    // Create a file before the tracker starts
    await writeFile(join(workspaceDir, 'stable.txt'), 'unchanged')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    // Track it via Layer 1 but don't modify it
    await tracker.trackBeforeWrite(join(workspaceDir, 'stable.txt'))

    const snapshot = await tracker.finalize()
    // Should NOT appear — content didn't change
    assert.equal(snapshot.entries.length, 0)

    tracker.dispose()
  })

  await t.test('background baseline captures originals for subprocess-modified files', async () => {
    // Create files before tracker starts — baseline will capture them.
    await writeFile(join(workspaceDir, 'config.txt'), 'original config')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')

    // Wait a tick for the baseline scan to pick up config.txt
    await new Promise((r) => setTimeout(r, 100))

    // Simulate a subprocess modifying the file (Layer 1/2 don't see this)
    await writeFile(join(workspaceDir, 'config.txt'), 'modified config')

    // Layer 3 scan detects the change — but baseline already has the original
    await tracker.scanWorkspace()
    const snapshot = await tracker.finalize()

    // The file should appear as modified with a real backup hash
    const entry = snapshot.entries.find((e) => e.relativePath === 'config.txt')
    assert.ok(entry, 'config.txt should be in the snapshot')
    assert.ok(entry.backupHash, 'should have a backup hash from the baseline')

    // Verify the backup is the original content
    const blob = await readBlob(tracker.workspaceHash, entry.backupHash!)
    assert.equal(blob.toString('utf8'), 'original config')

    tracker.dispose()
  })

  await t.test('dispose stops the background scan', async () => {
    // Create many files to slow down the scan
    for (let i = 0; i < 20; i++) {
      await writeFile(join(workspaceDir, `file-${i}.txt`), `content ${i}`)
    }

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    // Immediately dispose — should not throw or hang
    tracker.dispose()

    // Finalize should still work (with whatever was captured before abort)
    const snapshot = await tracker.finalize()
    assert.ok(snapshot)
    assert.equal(snapshot.runId, 'run-1')
  })

  await t.test('scanWorkspace skips node_modules', async () => {
    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    tracker.dispose() // stop baseline to isolate the test

    await new Promise((r) => setTimeout(r, 50))
    const nmDir = join(workspaceDir, 'node_modules', 'pkg')
    await mkdir(nmDir, { recursive: true })
    await writeFile(join(nmDir, 'index.js'), 'module')

    await tracker.scanWorkspace()
    const snapshot = await tracker.finalize()

    assert.ok(!snapshot.entries.some((e) => e.relativePath.includes('node_modules')))
  })

  await t.test('Layer 1 wins over background baseline', async () => {
    // File exists before tracker starts
    await writeFile(join(workspaceDir, 'race.txt'), 'v1')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')

    // Layer 1 tracks it immediately (before baseline finishes)
    await tracker.trackBeforeWrite(join(workspaceDir, 'race.txt'))

    // Modify the file
    await writeFile(join(workspaceDir, 'race.txt'), 'v2')

    const snapshot = await tracker.finalize()
    assert.equal(snapshot.entries.length, 1)

    // Should have the Layer 1 backup (v1), not whatever baseline captured
    const blob = await readBlob(tracker.workspaceHash, snapshot.entries[0]!.backupHash!)
    assert.equal(blob.toString('utf8'), 'v1')

    tracker.dispose()
  })
})
