import { describe, it, mock } from 'node:test'
import assert from 'node:assert'
import { ReadRecordCache, READ_RECORD_STALENESS_MS } from './readRecordCache.ts'

describe('ReadRecordCache', () => {
  it('reports false for a path never read', () => {
    const cache = new ReadRecordCache()
    assert.strictEqual(cache.hasRecentRead('/some/path.ts'), false)
  })

  it('reports true after a file read', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 50)
    assert.strictEqual(cache.hasRecentRead('/a.ts'), true)
  })

  it('treats different paths independently', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 100)
    assert.strictEqual(cache.hasRecentRead('/a.ts'), true)
    assert.strictEqual(cache.hasRecentRead('/b.ts'), false)
  })

  it('refreshes a path when it is read again', () => {
    const cache = new ReadRecordCache()
    const original = Date.now

    mock.method(Date, 'now', () => 100)
    cache.recordRead('/a.ts', 1, 10)
    mock.method(Date, 'now', () => 150)
    cache.recordRead('/a.ts', 100, 110)
    mock.method(Date, 'now', () => 200)

    try {
      assert.strictEqual(cache.hasRecentRead('/a.ts'), true)
    } finally {
      mock.method(Date, 'now', original)
    }
  })

  it('reports false after staleness window expires', () => {
    const cache = new ReadRecordCache(256, 100)
    cache.recordRead('/stale.ts', 1, 50)

    const original = Date.now
    mock.method(Date, 'now', () => original.call(Date) + 200)
    try {
      assert.strictEqual(cache.hasRecentRead('/stale.ts'), false)
    } finally {
      mock.method(Date, 'now', original)
    }
  })

  it('evicts oldest entries when exceeding max capacity', () => {
    const cache = new ReadRecordCache(3)
    cache.recordRead('/a.ts', 1, 10)
    cache.recordRead('/b.ts', 1, 10)
    cache.recordRead('/c.ts', 1, 10)
    cache.recordRead('/d.ts', 1, 10)

    assert.strictEqual(cache.hasRecentRead('/a.ts'), false)
    assert.strictEqual(cache.hasRecentRead('/b.ts'), true)
    assert.strictEqual(cache.hasRecentRead('/c.ts'), true)
    assert.strictEqual(cache.hasRecentRead('/d.ts'), true)
  })

  it('re-reading a path moves it to the tail', () => {
    const cache = new ReadRecordCache(3)
    cache.recordRead('/a.ts', 1, 10)
    cache.recordRead('/b.ts', 1, 10)
    cache.recordRead('/c.ts', 1, 10)

    cache.recordRead('/a.ts', 1, 10)
    cache.recordRead('/d.ts', 1, 10)

    assert.strictEqual(cache.hasRecentRead('/a.ts'), true)
    assert.strictEqual(cache.hasRecentRead('/b.ts'), false)
    assert.strictEqual(cache.hasRecentRead('/c.ts'), true)
    assert.strictEqual(cache.hasRecentRead('/d.ts'), true)
  })

  it('ignores empty ranges where startLine > endLine', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 100, 50)
    assert.strictEqual(cache.hasRecentRead('/a.ts'), false)
  })

  it('does not let an empty past-EOF read create a record', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 5, 4)
    assert.strictEqual(cache.hasRecentRead('/a.ts'), false)
  })

  it('exports the default staleness constant', () => {
    assert.strictEqual(READ_RECORD_STALENESS_MS, 10 * 60 * 1000)
  })

  it('invalidates when current mtime differs from recorded mtime', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 50, 1000)
    assert.strictEqual(cache.hasRecentRead('/a.ts', 1000), true)
    assert.strictEqual(cache.hasRecentRead('/a.ts', 2000), false)
  })

  it('passes when no mtime is provided on either side', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 50)
    assert.strictEqual(cache.hasRecentRead('/a.ts'), true)
    assert.strictEqual(cache.hasRecentRead('/a.ts', 1000), true)
  })

  it('passes when recorded mtime exists but check mtime is omitted', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 50, 1000)
    assert.strictEqual(cache.hasRecentRead('/a.ts'), true)
  })

  it('replaces the read record when mtime changes on a new read', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 50, 1000)
    cache.recordRead('/a.ts', 60, 80, 2000)
    assert.strictEqual(cache.hasRecentRead('/a.ts', 1000), false)
    assert.strictEqual(cache.hasRecentRead('/a.ts', 2000), true)
  })

  it('keeps the read record when mtime stays the same', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 50, 1000)
    cache.recordRead('/a.ts', 40, 80, 1000)
    assert.strictEqual(cache.hasRecentRead('/a.ts', 1000), true)
  })

  it('recordEmptyFileRead stores mtime', () => {
    const cache = new ReadRecordCache()
    cache.recordEmptyFileRead('/empty.ts', 500)
    assert.strictEqual(cache.hasRecentRead('/empty.ts', 500), true)
    assert.strictEqual(cache.hasRecentRead('/empty.ts', 999), false)
  })

  it('refreshMtime keeps the read record valid after self-modification', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 50, 1000)
    cache.refreshMtime('/a.ts', 2000)
    assert.strictEqual(cache.hasRecentRead('/a.ts', 2000), true)
    assert.strictEqual(cache.hasRecentRead('/a.ts', 1000), false)
  })

  it('refreshMtime is a no-op for unknown paths', () => {
    const cache = new ReadRecordCache()
    cache.refreshMtime('/unknown.ts', 2000)
    assert.strictEqual(cache.hasRecentRead('/unknown.ts'), false)
  })
})
