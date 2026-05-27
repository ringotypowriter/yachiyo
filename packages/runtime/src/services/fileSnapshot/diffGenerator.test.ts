import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { hashWorkspacePath } from './casStore.ts'
import { SnapshotTracker } from './snapshotTracker.ts'
import { generateDiffForRun, revertFile, revertRun } from './diffGenerator.ts'

const originalEnv = process.env['YACHIYO_HOME']

test('diffGenerator', async (t) => {
  let tempDir: string
  let workspaceDir: string

  t.beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'diff-gen-test-'))
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

  await t.test('generates diff for modified file', async () => {
    const filePath = join(workspaceDir, 'file.txt')
    await writeFile(filePath, 'line1\nline2\nline3\n')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    await tracker.trackBeforeWrite(filePath)

    // Modify the file
    await writeFile(filePath, 'line1\nline2-changed\nline3\n')
    await tracker.finalize()

    const changes = await generateDiffForRun(workspaceDir, 'run-1')
    assert.equal(changes.length, 1)
    assert.equal(changes[0]!.status, 'modified')
    assert.equal(changes[0]!.relativePath, 'file.txt')
    assert.ok(changes[0]!.diff.includes('-line2'))
    assert.ok(changes[0]!.diff.includes('+line2-changed'))
  })

  await t.test('generates diff for created file', async () => {
    const filePath = join(workspaceDir, 'new.txt')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    await tracker.trackBeforeWrite(filePath)

    // Create the file
    await writeFile(filePath, 'brand new content\n')
    await tracker.finalize()

    const changes = await generateDiffForRun(workspaceDir, 'run-1')
    assert.equal(changes.length, 1)
    assert.equal(changes[0]!.status, 'created')
    assert.ok(changes[0]!.diff.includes('+brand new content'))
    assert.ok(changes[0]!.diff.includes('--- /dev/null'))
  })

  await t.test('generates diff for deleted file', async () => {
    const filePath = join(workspaceDir, 'doomed.txt')
    await writeFile(filePath, 'goodbye\n')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    await tracker.trackBeforeWrite(filePath)

    // Delete the file
    await unlink(filePath)
    await tracker.finalize()

    const changes = await generateDiffForRun(workspaceDir, 'run-1')
    assert.equal(changes.length, 1)
    assert.equal(changes[0]!.status, 'deleted')
    assert.ok(changes[0]!.diff.includes('-goodbye'))
    assert.ok(changes[0]!.diff.includes('+++ /dev/null'))
  })

  await t.test('skips unchanged files', async () => {
    const filePath = join(workspaceDir, 'stable.txt')
    await writeFile(filePath, 'unchanged content')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    await tracker.trackBeforeWrite(filePath)
    // Don't modify the file
    await tracker.finalize()

    const changes = await generateDiffForRun(workspaceDir, 'run-1')
    assert.equal(changes.length, 0)
  })

  await t.test('revertFile restores modified file', async () => {
    const filePath = join(workspaceDir, 'file.txt')
    await writeFile(filePath, 'original')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    await tracker.trackBeforeWrite(filePath)
    await writeFile(filePath, 'modified')
    await tracker.finalize()

    await revertFile(workspaceDir, 'run-1', 'file.txt')
    const content = await readFile(filePath, 'utf8')
    assert.equal(content, 'original')
  })

  await t.test('reverted modified file shows as reverted in diff', async () => {
    const filePath = join(workspaceDir, 'file.txt')
    await writeFile(filePath, 'original')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    await tracker.trackBeforeWrite(filePath)
    await writeFile(filePath, 'modified')
    await tracker.finalize()

    const changesBefore = await generateDiffForRun(workspaceDir, 'run-1')
    assert.equal(changesBefore.length, 1)
    assert.equal(changesBefore[0]!.reverted, undefined)

    await revertFile(workspaceDir, 'run-1', 'file.txt')

    const changesAfter = await generateDiffForRun(workspaceDir, 'run-1')
    assert.equal(changesAfter.length, 1)
    assert.equal(changesAfter[0]!.reverted, true)
    assert.equal(changesAfter[0]!.status, 'modified')
    assert.ok(changesAfter[0]!.diff.includes('+modified'))
  })

  await t.test('reverted created file shows as reverted in diff', async () => {
    const filePath = join(workspaceDir, 'new.txt')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    await tracker.trackBeforeWrite(filePath)
    await writeFile(filePath, 'new content')
    await tracker.finalize()

    const changesBefore = await generateDiffForRun(workspaceDir, 'run-1')
    assert.equal(changesBefore.length, 1)
    assert.equal(changesBefore[0]!.reverted, undefined)

    await revertFile(workspaceDir, 'run-1', 'new.txt')

    const changesAfter = await generateDiffForRun(workspaceDir, 'run-1')
    assert.equal(changesAfter.length, 1)
    assert.equal(changesAfter[0]!.reverted, true)
    assert.equal(changesAfter[0]!.status, 'created')
    assert.ok(changesAfter[0]!.diff.includes('+new content'))
  })

  await t.test('revertFile deletes created file', async () => {
    const filePath = join(workspaceDir, 'new.txt')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    await tracker.trackBeforeWrite(filePath)
    await writeFile(filePath, 'new content')
    await tracker.finalize()

    await revertFile(workspaceDir, 'run-1', 'new.txt')
    await assert.rejects(() => access(filePath))
  })

  await t.test('revertRun reverts all files', async () => {
    const file1 = join(workspaceDir, 'a.txt')
    const file2 = join(workspaceDir, 'b.txt')
    await writeFile(file1, 'a-original')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    await tracker.trackBeforeWrite(file1)
    await tracker.trackBeforeWrite(file2)

    await writeFile(file1, 'a-modified')
    await writeFile(file2, 'b-created')
    await tracker.finalize()

    await revertRun(workspaceDir, 'run-1')

    const a = await readFile(file1, 'utf8')
    assert.equal(a, 'a-original')
    await assert.rejects(() => access(file2))
  })

  await t.test('returns empty for unknown run', async () => {
    const changes = await generateDiffForRun(workspaceDir, 'nonexistent')
    assert.equal(changes.length, 0)
  })

  await t.test('survives a missing backup blob without blanking other entries', async () => {
    const good = join(workspaceDir, 'keep.txt')
    const broken = join(workspaceDir, 'orphan.txt')
    await writeFile(good, 'good-original\n')
    await writeFile(broken, 'broken-original\n')

    const tracker = new SnapshotTracker(workspaceDir, 'run-1', 'thread-1')
    await tracker.trackBeforeWrite(good)
    await tracker.trackBeforeWrite(broken)

    await writeFile(good, 'good-modified\n')
    await writeFile(broken, 'broken-modified\n')
    const snapshot = await tracker.finalize()

    // Simulate the exact failure mode: an older run's backup blob gets
    // swept while its snapshot index still references it.
    const brokenEntry = snapshot.entries.find((e) => e.relativePath === 'orphan.txt')!
    assert.ok(brokenEntry.backupHash)
    const backupsDir = join(tempDir, 'file-history', hashWorkspacePath(workspaceDir), 'backups')
    await unlink(join(backupsDir, brokenEntry.backupHash!))

    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = (msg: string) => warnings.push(msg)
    try {
      const changes = await generateDiffForRun(workspaceDir, 'run-1')
      const byPath = new Map(changes.map((c) => [c.relativePath, c]))
      const goodChange = byPath.get('keep.txt')
      const brokenChange = byPath.get('orphan.txt')
      assert.ok(goodChange, 'healthy entry must still be reported')
      assert.equal(goodChange!.status, 'modified')
      assert.ok(goodChange!.diff.includes('+good-modified'))
      assert.ok(brokenChange, 'entry with missing backup must still appear')
      assert.equal(brokenChange!.status, 'modified')
      assert.ok(brokenChange!.diff.includes('unavailable'))
      assert.ok(brokenChange!.diff.includes('+broken-modified'))
      assert.ok(warnings.some((w) => w.includes('Missing backup blob')))
    } finally {
      console.warn = originalWarn
    }
  })
})
