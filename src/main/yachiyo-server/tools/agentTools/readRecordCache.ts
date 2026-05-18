/**
 * Runtime-only LRU cache tracking which file paths have been read recently.
 *
 * Used by the edit and write tools to enforce a "read-before-modify" guard:
 * the model must read a file before editing or overwriting it, ensuring it
 * has seen the current contents and does not blindly clobber data.
 *
 * The cache is file-aware: any successful file read authorizes future edits
 * until the record gets stale or the file mtime changes.
 */

/** How long a read record stays valid before the model must re-read. */
export const READ_RECORD_STALENESS_MS = 10 * 60 * 1000 // 10 minutes

/** Maximum number of paths tracked. Oldest entries are evicted first. */
export const READ_RECORD_MAX_ENTRIES = 256

interface FileEntry {
  timestamp: number
  /** File mtime (ms) captured at read time. A later mtime invalidates the record. */
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
   * were just read. Line arguments are kept for call-site compatibility; any
   * non-empty range records the file as read. If `mtimeMs` is provided, a
   * later mtime will invalidate the record.
   */
  recordRead(path: string, startLine: number, endLine: number, mtimeMs?: number): void {
    if (startLine > endLine) return

    this.entries.delete(path)
    this.entries.set(path, { timestamp: Date.now(), mtimeMs })
    this.evict()
  }

  /**
   * Record that a file was read and found to be empty (zero lines).
   * This satisfies `hasRecentRead` so the write-overwrite guard passes.
   */
  recordEmptyFileRead(path: string, mtimeMs?: number): void {
    this.entries.delete(path)
    this.entries.set(path, { timestamp: Date.now(), mtimeMs })
    this.evict()
  }

  /**
   * Update the stored mtime for a path after a successful self-modification
   * (edit/write), keeping the read record valid for the next mutation.
   */
  refreshMtime(path: string, newMtimeMs: number): void {
    const entry = this.entries.get(path)
    if (entry) {
      entry.mtimeMs = newMtimeMs
    }
  }

  /**
   * Returns true if the path has a recent read record.
   * If `currentMtimeMs` is provided and differs from the recorded mtime,
   * the file has been modified since the read and the record is invalid.
   */
  hasRecentRead(path: string, currentMtimeMs?: number): boolean {
    const entry = this.entries.get(path)
    if (!entry) return false
    if (
      currentMtimeMs !== undefined &&
      entry.mtimeMs !== undefined &&
      currentMtimeMs !== entry.mtimeMs
    ) {
      return false
    }
    return Date.now() - entry.timestamp < this.stalenessMs
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }
}
