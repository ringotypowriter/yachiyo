import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { createTtlReaper } from './ttlReaper.ts'

function makeTempDir(): string {
  return join(tmpdir(), `ttl-reaper-test-${randomUUID()}`)
}

describe('TtlReaper', () => {
  let tempDir: string
  let manifestPath: string

  beforeEach(async () => {
    tempDir = makeTempDir()
    await mkdir(tempDir, { recursive: true })
    manifestPath = join(tempDir, 'ttl-manifest.json')
  })

  it('register creates a manifest with the entry', async () => {
    const reaper = createTtlReaper({ manifestPath })
    reaper.register('/some/path', 60_000)

    await reaper.sweep()

    const raw = await readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(raw)
    assert.ok(manifest['/some/path'])
    assert.equal(manifest['/some/path'].ttlMs, 60_000)
    assert.ok(manifest['/some/path'].createdAt)
  })

  it('register appends to existing manifest', async () => {
    const reaper = createTtlReaper({ manifestPath })
    reaper.register('/path/a', 60_000)
    await reaper.sweep()

    reaper.register('/path/b', 120_000)
    await reaper.sweep()

    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    assert.ok(manifest['/path/a'])
    assert.ok(manifest['/path/b'])
  })

  it('sweep deletes expired files', async () => {
    const filePath = join(tempDir, 'expired-file.txt')
    await writeFile(filePath, 'hello')

    let fakeTime = new Date('2025-01-01T00:00:00Z')
    const reaper = createTtlReaper({
      manifestPath,
      now: () => fakeTime
    })

    reaper.register(filePath, 1000) // 1 second TTL

    // Advance time past TTL
    fakeTime = new Date('2025-01-01T00:01:00Z')

    const result = await reaper.sweep()
    assert.deepEqual(result.deleted, [filePath])

    // File should be gone
    await assert.rejects(() => readFile(filePath), { code: 'ENOENT' })
  })

  it('sweep waits for an in-flight registration write before reading the manifest', async (context) => {
    const filePath = join(tempDir, 'slow-registration.txt')
    await writeFile(filePath, 'hello')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const realRead = fs.readFile
    const realWrite = fs.writeFile
    let manifestReads = 0
    let gated = false
    context.mock.method(fs, 'readFile', (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === manifestPath) manifestReads += 1
      return realRead(...args)
    })
    context.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
      if (args[0] === manifestPath && !gated) {
        gated = true
        entered.resolve()
        await release.promise
      }
      return realWrite(...args)
    })
    syncBuiltinESMExports()
    let fakeTime = new Date('2025-01-01T00:00:00Z')
    const reaper = createTtlReaper({ manifestPath, now: () => fakeTime })
    let sweeping: ReturnType<typeof reaper.sweep> | undefined
    try {
      reaper.register(filePath, 1000)
      await entered.promise
      fakeTime = new Date('2025-01-01T00:01:00Z')
      sweeping = reaper.sweep()
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(manifestReads, 1, 'sweep must not read while the registration write is blocked')
      release.resolve()
      assert.deepEqual((await sweeping).deleted, [filePath])
      await assert.rejects(() => realRead(filePath), { code: 'ENOENT' })
    } finally {
      release.resolve()
      await sweeping
      context.mock.restoreAll()
      syncBuiltinESMExports()
    }
  })

  it('sweep preserves non-expired files', async () => {
    const filePath = join(tempDir, 'fresh-file.txt')
    await writeFile(filePath, 'hello')

    const fakeTime = new Date('2025-01-01T00:00:00Z')
    const reaper = createTtlReaper({
      manifestPath,
      now: () => fakeTime
    })

    reaper.register(filePath, 3_600_000) // 1 hour TTL

    const result = await reaper.sweep()
    assert.deepEqual(result.deleted, [])

    // File should still exist
    const content = await readFile(filePath, 'utf8')
    assert.equal(content, 'hello')
  })

  it('sweep handles already-deleted files gracefully', async () => {
    let fakeTime = new Date('2025-01-01T00:00:00Z')
    const reaper = createTtlReaper({
      manifestPath,
      now: () => fakeTime
    })

    // Register a path that doesn't exist on disk
    reaper.register('/nonexistent/path/file.txt', 1000)

    fakeTime = new Date('2025-01-01T01:00:00Z')

    // Should not throw
    const result = await reaper.sweep()
    assert.deepEqual(result.deleted, ['/nonexistent/path/file.txt'])
  })

  it('sweep handles corrupt manifest gracefully', async () => {
    await writeFile(manifestPath, 'not valid json!!!', 'utf8')

    const reaper = createTtlReaper({ manifestPath })
    const result = await reaper.sweep()
    assert.deepEqual(result.deleted, [])
  })

  it('sweep handles missing manifest gracefully', async () => {
    const reaper = createTtlReaper({ manifestPath })
    const result = await reaper.sweep()
    assert.deepEqual(result.deleted, [])
  })

  it('sweep creates a missing manifest parent directory', async () => {
    const nestedManifestPath = join(tempDir, 'missing', 'ttl-manifest.json')
    const reaper = createTtlReaper({ manifestPath: nestedManifestPath })

    const result = await reaper.sweep()

    assert.deepEqual(result.deleted, [])
    assert.deepEqual(JSON.parse(await readFile(nestedManifestPath, 'utf8')), {})
  })

  it('sweep deletes directories recursively', async () => {
    const dirPath = join(tempDir, 'attachments', 'msg-123')
    await mkdir(dirPath, { recursive: true })
    await writeFile(join(dirPath, 'image.png'), 'fake image')

    let fakeTime = new Date('2025-01-01T00:00:00Z')
    const reaper = createTtlReaper({
      manifestPath,
      now: () => fakeTime
    })

    reaper.register(dirPath, 1000)

    fakeTime = new Date('2025-01-01T01:00:00Z')

    const result = await reaper.sweep()
    assert.deepEqual(result.deleted, [dirPath])

    // Directory should be gone
    await assert.rejects(() => readFile(join(dirPath, 'image.png')), { code: 'ENOENT' })
  })

  it('stop clears the interval', async () => {
    const reaper = createTtlReaper({ manifestPath, intervalMs: 100 })
    reaper.start()
    reaper.stop()

    // If stop didn't work, the interval would keep firing. Just verify it doesn't throw.
    await new Promise((r) => setTimeout(r, 200))
  })

  // Cleanup
  it('cleanup temp dir', async () => {
    await rm(tempDir, { recursive: true, force: true })
  })
})
