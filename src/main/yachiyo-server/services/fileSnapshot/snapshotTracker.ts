import { access, readFile, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { glob } from 'fast-glob'

import type {
  FileSnapshotEntry,
  RunSnapshot,
  SnapshotSummary
} from '../../../../shared/yachiyo/fileSnapshot.ts'
import { hashContent, hashWorkspacePath, storeBlob } from './casStore.ts'
import { loadSnapshotIndex, listSnapshotRuns, saveSnapshotIndex } from './snapshotIndex.ts'

/** Directories to skip during workspace scans. */
const SCAN_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/.yachiyo/**',
  '**/.cache/**',
  '**/__pycache__/**'
]

/** Maximum glob depth for workspace scans. */
const SCAN_DEPTH = 4

interface TrackedEntry {
  hash: string
  size: number
  /** 'tool' = captured by Layer 1/2, 'baseline' = captured by background scan. */
  source: 'tool' | 'baseline'
}

/**
 * Per-run tracker that captures file states before modifications.
 *
 * On construction, a background baseline scan begins immediately — reading
 * and storing every shallow workspace file in the CAS pool. This runs
 * concurrently with the agent run so it adds zero latency to tool calls.
 *
 * Layers:
 * 1. `trackBeforeWrite(path)` — called by write/edit tools before each write.
 * 2. Bash pre-backup — called before bash spawns for edit/write commands.
 * 3. Post-run `scanWorkspace()` — detects files changed during the run that
 *    Layer 1/2 missed. Because the baseline scan captured originals upfront,
 *    these files get real diffs instead of showing as "created".
 *
 * Priority: Layer 1/2 (tool) always beats the baseline. If a tool call writes
 * a file that the baseline hasn't reached yet, Layer 1/2 captures the true
 * pre-write content. If the baseline already stored an entry, Layer 1/2
 * overwrites it — the tool call is closer to the actual write moment.
 */
export class SnapshotTracker {
  readonly workspacePath: string
  readonly workspaceHash: string
  readonly runId: string
  readonly threadId: string
  readonly runStartTime: number

  /**
   * absolutePath → tracked backup info, or null for truly new files.
   * Entries with source='tool' are authoritative and never overwritten.
   */
  private readonly trackedFiles = new Map<string, TrackedEntry | null>()

  /** Signals the background baseline scan to stop early. */
  private readonly abortController = new AbortController()

  /** Resolves when the background baseline scan finishes (or is aborted). */
  private readonly baselineReady: Promise<void>

  constructor(workspacePath: string, runId: string, threadId: string) {
    this.workspacePath = resolve(workspacePath)
    this.workspaceHash = hashWorkspacePath(this.workspacePath)
    this.runId = runId
    this.threadId = threadId
    this.runStartTime = Date.now()

    this.baselineReady = this.runBaselineScan().catch((err) => {
      if (!this.abortController.signal.aborted) {
        console.error('[snapshot] Baseline scan failed:', err)
      }
    })
  }

  /** Whether any files have been tracked. */
  get hasTrackedFiles(): boolean {
    return this.trackedFiles.size > 0
  }

  /**
   * Stop the background baseline scan early.
   * Call this when the run is cancelled or restarted.
   */
  dispose(): void {
    this.abortController.abort()
  }

  /**
   * Track a file before it is written/edited (Layers 1 and 2).
   *
   * Always overwrites baseline entries — the tool call captures the true
   * pre-write content, which is more accurate than whatever the baseline
   * read (which may have been the already-modified version if the baseline
   * was slow).
   *
   * Idempotent for repeated Layer 1/2 calls on the same path.
   */
  async trackBeforeWrite(absolutePath: string): Promise<void> {
    const resolved = resolve(absolutePath)

    // Skip if already captured by a previous tool call.
    const existing = this.trackedFiles.get(resolved)
    if (existing === null || existing?.source === 'tool') return

    try {
      await access(resolved)
      const content = await readFile(resolved)
      const hash = await storeBlob(this.workspaceHash, content)
      this.trackedFiles.set(resolved, { hash, size: content.length, source: 'tool' })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist — will be newly created
        this.trackedFiles.set(resolved, null)
      } else {
        console.error(`[snapshot] Failed to track ${resolved}:`, err)
      }
    }
  }

  /**
   * Layer 3: Post-run scan.
   * Waits for the background baseline to finish, then checks which baselined
   * files actually changed during the run. New files created during the run
   * (not in the baseline) are detected via mtime.
   */
  async scanWorkspace(): Promise<void> {
    await this.baselineReady

    try {
      const files = await glob('**/*', {
        cwd: this.workspacePath,
        absolute: true,
        onlyFiles: true,
        deep: SCAN_DEPTH,
        ignore: SCAN_IGNORE,
        followSymbolicLinks: false
      })

      for (const file of files) {
        if (this.trackedFiles.has(file)) continue

        try {
          const fileStat = await stat(file)
          if (fileStat.mtimeMs >= this.runStartTime) {
            // Truly new file created during the run (not in baseline).
            this.trackedFiles.set(file, null)
          }
        } catch {
          // Skip files we can't stat
        }
      }
    } catch (err) {
      console.error('[snapshot] Post-run scan failed:', err)
    }
  }

  /** Persist the snapshot index to disk. Returns the snapshot data. */
  async finalize(): Promise<RunSnapshot> {
    const entries: FileSnapshotEntry[] = []

    for (const [absolutePath, tracked] of this.trackedFiles) {
      const relativePath = relative(this.workspacePath, absolutePath)

      // Capture the after-state and check if the file actually changed.
      let afterHash: string | null = null
      try {
        const currentContent = await readFile(absolutePath)
        afterHash = hashContent(currentContent)

        // If the file didn't change, skip this entry.
        if (tracked && afterHash === tracked.hash) continue

        // Store the after-content in CAS so history diffs can use it.
        await storeBlob(this.workspaceHash, currentContent)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          // File was deleted during the run
          afterHash = null
          // If the file was newly created (null backup) and then deleted, skip.
          if (!tracked) continue
        } else {
          continue // Skip files we can't read
        }
      }

      entries.push({
        relativePath,
        backupHash: tracked?.hash ?? null,
        originalSize: tracked?.size ?? 0,
        afterHash
      })
    }

    entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath))

    const snapshot: RunSnapshot = {
      runId: this.runId,
      threadId: this.threadId,
      workspacePath: this.workspacePath,
      createdAt: new Date().toISOString(),
      entries
    }

    await saveSnapshotIndex(this.workspaceHash, snapshot)
    return snapshot
  }

  // ---------------------------------------------------------------------------
  // Background baseline scan
  // ---------------------------------------------------------------------------

  private async runBaselineScan(): Promise<void> {
    const signal = this.abortController.signal

    const files = await glob('**/*', {
      cwd: this.workspacePath,
      absolute: true,
      onlyFiles: true,
      deep: SCAN_DEPTH,
      ignore: SCAN_IGNORE,
      followSymbolicLinks: false
    })

    for (const file of files) {
      if (signal.aborted) return

      // Never overwrite a Layer 1/2 entry or a null (new-file) entry.
      const existing = this.trackedFiles.get(file)
      if (existing === null || existing?.source === 'tool') continue

      try {
        const content = await readFile(file)
        if (signal.aborted) return

        // Re-check: a tool call may have won the race while we were reading.
        const afterRead = this.trackedFiles.get(file)
        if (afterRead === null || afterRead?.source === 'tool') continue

        const hash = await storeBlob(this.workspaceHash, content)

        // Final check: a tool call may have won while we were storing the blob.
        const beforeSet = this.trackedFiles.get(file)
        if (beforeSet === null || beforeSet?.source === 'tool') continue

        this.trackedFiles.set(file, { hash, size: content.length, source: 'baseline' })
      } catch {
        // Skip files we can't read (binary, permissions, etc.)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Static query helpers
  // ---------------------------------------------------------------------------

  static async loadSnapshot(workspaceHash: string, runId: string): Promise<RunSnapshot | null> {
    return loadSnapshotIndex(workspaceHash, runId)
  }

  static async listSnapshots(workspaceHash: string): Promise<SnapshotSummary[]> {
    return listSnapshotRuns(workspaceHash)
  }
}
