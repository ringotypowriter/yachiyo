/**
 * Runtime-only LRU cache tracking which file paths (and line ranges) have
 * been read recently.
 *
 * Used by the edit and write tools to enforce a "read-before-modify" guard:
 * the model must read a file before editing or overwriting it, ensuring it
 * has seen the current contents and does not blindly clobber data.
 *
 * The cache is range-aware: partial reads (offset/limit pagination) record
 * only the lines actually returned, and the edit guard verifies that the
 * target edit line falls within a recently-read range.
 */

/** How long a read record stays valid before the model must re-read. */
export const READ_RECORD_STALENESS_MS = 10 * 60 * 1000 // 10 minutes

/** Maximum number of paths tracked. Oldest entries are evicted first. */
export const READ_RECORD_MAX_ENTRIES = 256

interface ReadRange {
  /** 1-based inclusive start line. */
  startLine: number
  /** 1-based inclusive end line. */
  endLine: number
  timestamp: number
}

interface FileEntry {
  ranges: ReadRange[]
  /** File mtime (ms) captured at read time. A later mtime invalidates all ranges. */
  mtimeMs: number | undefined
}

export class ReadRecordCache {
  private entries = new Map<string, FileEntry>()
  private readonly maxEntries: number
  private readonly stalenessMs: number

  constructor(
    maxEntries: number = READ_RECORD_MAX_ENTRIES,
    stalenessMs: number = READ_RECORD_STALENESS_MS
  ) {
    this.maxEntries = maxEntries
    this.stalenessMs = stalenessMs
  }

  /**
   * Record that lines [startLine, endLine] (1-based inclusive) of a file
   * were just read. Overlapping or adjacent ranges are merged automatically.
   * If `mtimeMs` is provided, a later mtime will invalidate all prior ranges.
   */
  recordRead(path: string, startLine: number, endLine: number, mtimeMs?: number): void {
    if (startLine > endLine) return

    const existing = this.entries.get(path)
    this.entries.delete(path)

    const now = Date.now()
    const newRange: ReadRange = { startLine, endLine, timestamp: now }

    if (
      !existing ||
      (mtimeMs !== undefined && existing.mtimeMs !== undefined && mtimeMs !== existing.mtimeMs)
    ) {
      this.entries.set(path, { ranges: [newRange], mtimeMs })
    } else {
      const fresh = existing.ranges.filter((r) => now - r.timestamp < this.stalenessMs)
      fresh.push(newRange)
      this.entries.set(path, { ranges: mergeRanges(fresh), mtimeMs: mtimeMs ?? existing.mtimeMs })
    }

    this.evict()
  }

  /**
   * Record that a file was read and found to be empty (zero lines).
   * This satisfies `hasRecentRead` so the write-overwrite guard passes,
   * but `coversLine` will still return false for any line number since
   * there are no lines to cover.
   */
  recordEmptyFileRead(path: string, mtimeMs?: number): void {
    this.entries.delete(path)
    this.entries.set(path, {
      ranges: [{ startLine: 0, endLine: 0, timestamp: Date.now() }],
      mtimeMs
    })
    this.evict()
  }

  /**
   * Returns true if the given 1-based line number falls within a
   * recently-read range for this path.
   * If `currentMtimeMs` is provided and differs from the recorded mtime,
   * the file has been modified since the read — returns false.
   */
  coversLine(path: string, line: number, currentMtimeMs?: number): boolean {
    const ranges = this.getFreshRanges(path, currentMtimeMs)
    if (!ranges) return false
    return ranges.some((r) => line >= r.startLine && line <= r.endLine)
  }

  /**
   * Returns true if the path has any recent read record at all.
   * If `currentMtimeMs` is provided and differs from the recorded mtime,
   * the file has been modified since the read — returns false.
   */
  /**
   * Update the stored mtime for a path after a successful self-modification
   * (edit/write), keeping existing ranges valid for the next mutation.
   */
  refreshMtime(path: string, newMtimeMs: number): void {
    const entry = this.entries.get(path)
    if (entry) {
      entry.mtimeMs = newMtimeMs
    }
  }

  hasRecentRead(path: string, currentMtimeMs?: number): boolean {
    const ranges = this.getFreshRanges(path, currentMtimeMs)
    return ranges !== undefined && ranges.length > 0
  }

  private getFreshRanges(path: string, currentMtimeMs?: number): ReadRange[] | undefined {
    const entry = this.entries.get(path)
    if (!entry) return undefined
    if (
      currentMtimeMs !== undefined &&
      entry.mtimeMs !== undefined &&
      currentMtimeMs !== entry.mtimeMs
    ) {
      return undefined
    }
    const now = Date.now()
    const fresh = entry.ranges.filter((r) => now - r.timestamp < this.stalenessMs)
    return fresh.length > 0 ? fresh : undefined
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }
}

/**
 * Sort ranges by startLine and merge any that overlap or are adjacent.
 * Merged ranges inherit the latest timestamp.
 */
function mergeRanges(ranges: ReadRange[]): ReadRange[] {
  if (ranges.length <= 1) return ranges
  const sorted = ranges.slice().sort((a, b) => a.startLine - b.startLine)
  const merged: ReadRange[] = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]
    const last = merged[merged.length - 1]
    // Adjacent (endLine + 1 >= nextStart) or overlapping — merge.
    if (current.startLine <= last.endLine + 1) {
      last.endLine = Math.max(last.endLine, current.endLine)
      last.timestamp = Math.max(last.timestamp, current.timestamp)
    } else {
      merged.push(current)
    }
  }

  return merged
}
