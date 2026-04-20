import { describe, it, mock } from 'node:test'
import assert from 'node:assert'
import { ReadRecordCache, READ_RECORD_STALENESS_MS } from './readRecordCache.ts'

describe('ReadRecordCache', () => {
  it('reports false for a path never read', () => {
    const cache = new ReadRecordCache()
    assert.strictEqual(cache.hasRecentRead('/some/path.ts'), false)
    assert.strictEqual(cache.coversLine('/some/path.ts', 1), false)
  })

  it('reports true for lines within a recorded range', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 50)
    assert.strictEqual(cache.hasRecentRead('/a.ts'), true)
    assert.strictEqual(cache.coversLine('/a.ts', 1), true)
    assert.strictEqual(cache.coversLine('/a.ts', 25), true)
    assert.strictEqual(cache.coversLine('/a.ts', 50), true)
  })

  it('reports false for lines outside the recorded range', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 10, 30)
    assert.strictEqual(cache.coversLine('/a.ts', 9), false)
    assert.strictEqual(cache.coversLine('/a.ts', 31), false)
  })

  it('treats different paths independently', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 100)
    assert.strictEqual(cache.coversLine('/a.ts', 50), true)
    assert.strictEqual(cache.coversLine('/b.ts', 50), false)
  })

  it('merges overlapping ranges from multiple reads', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 50)
    cache.recordRead('/a.ts', 40, 100)
    // Lines across the merged range should all be covered.
    assert.strictEqual(cache.coversLine('/a.ts', 1), true)
    assert.strictEqual(cache.coversLine('/a.ts', 45), true)
    assert.strictEqual(cache.coversLine('/a.ts', 100), true)
    assert.strictEqual(cache.coversLine('/a.ts', 101), false)
  })

  it('merges adjacent ranges (endLine + 1 === next startLine)', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 50)
    cache.recordRead('/a.ts', 51, 100)
    assert.strictEqual(cache.coversLine('/a.ts', 50), true)
    assert.strictEqual(cache.coversLine('/a.ts', 51), true)
    assert.strictEqual(cache.coversLine('/a.ts', 75), true)
  })

  it('keeps disjoint ranges separate', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 30)
    cache.recordRead('/a.ts', 60, 90)
    assert.strictEqual(cache.coversLine('/a.ts', 15), true)
    assert.strictEqual(cache.coversLine('/a.ts', 45), false) // gap
    assert.strictEqual(cache.coversLine('/a.ts', 75), true)
  })

  it('reports false after staleness window expires', () => {
    const cache = new ReadRecordCache(256, 100) // 100ms staleness
    cache.recordRead('/stale.ts', 1, 50)

    const original = Date.now
    mock.method(Date, 'now', () => original.call(Date) + 200)
    try {
      assert.strictEqual(cache.hasRecentRead('/stale.ts'), false)
      assert.strictEqual(cache.coversLine('/stale.ts', 25), false)
    } finally {
      mock.method(Date, 'now', original)
    }
  })

  it('evicts oldest entries when exceeding max capacity', () => {
    const cache = new ReadRecordCache(3)
    cache.recordRead('/a.ts', 1, 10)
    cache.recordRead('/b.ts', 1, 10)
    cache.recordRead('/c.ts', 1, 10)
    cache.recordRead('/d.ts', 1, 10) // evicts /a.ts

    assert.strictEqual(cache.hasRecentRead('/a.ts'), false)
    assert.strictEqual(cache.hasRecentRead('/b.ts'), true)
    assert.strictEqual(cache.hasRecentRead('/c.ts'), true)
    assert.strictEqual(cache.hasRecentRead('/d.ts'), true)
  })

  it('re-reading a path moves it to the tail (not evicted early)', () => {
    const cache = new ReadRecordCache(3)
    cache.recordRead('/a.ts', 1, 10)
    cache.recordRead('/b.ts', 1, 10)
    cache.recordRead('/c.ts', 1, 10)

    // Re-read /a.ts — moves it to the tail
    cache.recordRead('/a.ts', 1, 10)
    // Add /d.ts — should evict /b.ts (oldest) instead of /a.ts
    cache.recordRead('/d.ts', 1, 10)

    assert.strictEqual(cache.hasRecentRead('/a.ts'), true)
    assert.strictEqual(cache.hasRecentRead('/b.ts'), false)
    assert.strictEqual(cache.hasRecentRead('/c.ts'), true)
    assert.strictEqual(cache.hasRecentRead('/d.ts'), true)
  })

  it('ignores empty ranges where startLine > endLine', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 100, 50) // inverted range — nothing was read
    assert.strictEqual(cache.hasRecentRead('/a.ts'), false)
    assert.strictEqual(cache.coversLine('/a.ts', 100), false)
  })

  it('does not let an empty read create a record that hasRecentRead sees', () => {
    const cache = new ReadRecordCache()
    // Simulate offset-past-EOF: startLine 5, endLine 4 (empty)
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
    assert.strictEqual(cache.coversLine('/a.ts', 25, 1000), true)
    assert.strictEqual(cache.hasRecentRead('/a.ts', 2000), false)
    assert.strictEqual(cache.coversLine('/a.ts', 25, 2000), false)
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
    assert.strictEqual(cache.coversLine('/a.ts', 25), true)
  })

  it('resets ranges when mtime changes on a new read', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 50, 1000)
    cache.recordRead('/a.ts', 60, 80, 2000)
    assert.strictEqual(cache.coversLine('/a.ts', 25, 2000), false)
    assert.strictEqual(cache.coversLine('/a.ts', 70, 2000), true)
  })

  it('merges ranges when mtime stays the same', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 50, 1000)
    cache.recordRead('/a.ts', 40, 80, 1000)
    assert.strictEqual(cache.coversLine('/a.ts', 25, 1000), true)
    assert.strictEqual(cache.coversLine('/a.ts', 70, 1000), true)
  })

  it('recordEmptyFileRead stores mtime', () => {
    const cache = new ReadRecordCache()
    cache.recordEmptyFileRead('/empty.ts', 500)
    assert.strictEqual(cache.hasRecentRead('/empty.ts', 500), true)
    assert.strictEqual(cache.hasRecentRead('/empty.ts', 999), false)
  })

  it('refreshMtime keeps ranges valid after self-modification', () => {
    const cache = new ReadRecordCache()
    cache.recordRead('/a.ts', 1, 50, 1000)
    cache.refreshMtime('/a.ts', 2000)
    assert.strictEqual(cache.hasRecentRead('/a.ts', 2000), true)
    assert.strictEqual(cache.coversLine('/a.ts', 25, 2000), true)
    assert.strictEqual(cache.hasRecentRead('/a.ts', 1000), false)
  })

  it('refreshMtime is a no-op for unknown paths', () => {
    const cache = new ReadRecordCache()
    cache.refreshMtime('/unknown.ts', 1000)
    assert.strictEqual(cache.hasRecentRead('/unknown.ts'), false)
  })
})
