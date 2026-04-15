import { access, readFile, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

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

/** Shared system directories to skip during external scans. */
const SHARED_EXTERNAL_BLACKLIST = new Set(
  [
    '/tmp',
    '/var/tmp',
    '/dev/shm',
    '/private/tmp',
    '/private/var/tmp',
    '/var/folders',
    '/run',
    '/var/run',
    tmpdir()
  ].map((p) => resolve(p))
)

function isBlacklistedExternalDir(dir: string): boolean {
  const resolvedDir = resolve(dir)
  for (const blacklisted of SHARED_EXTERNAL_BLACKLIST) {
    if (resolvedDir === blacklisted || resolvedDir.startsWith(blacklisted + '/')) {
      return true
    }
  }
  return false
}

/** Cached fast-glob glob function to avoid repeated dynamic imports. */
let cachedGlob:
  | ((pattern: string | string[], options: Record<string, unknown>) => Promise<string[]>)
  | null = null

/** Lazy-import fast-glob to avoid CJS interop issues at module parse time. */
async function globFiles(
  cwd: string,
  deep: number,
  ignore: string[],
  signal?: AbortSignal
): Promise<string[]> {
  if (signal?.aborted) return []
  if (!cachedGlob) {
    const fg = await import('fast-glob')
    cachedGlob = fg.default.glob
  }
  if (signal?.aborted) return []
  return cachedGlob('**/*', {
    cwd,
    absolute: true,
    onlyFiles: true,
    deep,
    ignore,
    followSymbolicLinks: false
  })
}

/** Load .gitignore from the workspace root (if present) and return a filter. */
async function loadGitignoreFilter(
  workspacePath: string
): Promise<((relativePath: string) => boolean) | null> {
  try {
    const gitignorePath = join(workspacePath, '.gitignore')
    const content = await readFile(gitignorePath, 'utf8')
    const ig = (await import('ignore')).default()
    ig.add(content)
    return (rel: string) => ig.ignores(rel)
  } catch {
    return null
  }
}

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
  private baselineReady: Promise<void> = Promise.resolve()

  /** Filter function loaded from .gitignore (null = no gitignore or load failed). */
  private gitignoreFilter: ((relativePath: string) => boolean) | null = null
  private gitignoreLoaded = false

  constructor(workspacePath: string, runId: string, threadId: string) {
    this.workspacePath = resolve(workspacePath)
    this.workspaceHash = hashWorkspacePath(this.workspacePath)
    this.runId = runId
    this.threadId = threadId
    this.runStartTime = Date.now()
  }

  /** Check if a file is gitignored. Returns false if no .gitignore loaded. */
  private isGitignored(absolutePath: string): boolean {
    if (!this.gitignoreFilter) return false
    const rel = relative(this.workspacePath, absolutePath)
    if (rel.startsWith('..') || rel === absolutePath) return false
    return this.gitignoreFilter(rel)
  }

  /** Lazily load the .gitignore filter (once per tracker). */
  private async ensureGitignore(): Promise<void> {
    if (this.gitignoreLoaded) return
    this.gitignoreLoaded = true
    this.gitignoreFilter = await loadGitignoreFilter(this.workspacePath)
  }

  /**
   * Start the background baseline scan. Call once after construction.
   * Fire-and-forget — the scan runs concurrently with the agent run.
   * Must be called explicitly so tests don't get lingering async work.
   */
  startBaselineScan(): void {
    // Use a deferred promise so the baseline scan's I/O doesn't prevent
    // the Node process from exiting (important for tests). The scan runs
    // on the next tick via an unref'd timer; scanWorkspace() awaits the
    // result before finalization.
    let resolve!: () => void
    this.baselineReady = new Promise<void>((r) => {
      resolve = r
    })
    const timer = setTimeout(() => {
      this.runBaselineScan()
        .catch((err) => {
          if (!this.abortController.signal.aborted) {
            console.error('[snapshot] Baseline scan failed:', err)
          }
        })
        .finally(resolve)
    }, 0)
    // unref so this timer alone doesn't keep the process alive
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
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
    await this.ensureGitignore()

    // Scan the workspace
    try {
      const files = await globFiles(this.workspacePath, SCAN_DEPTH, SCAN_IGNORE)

      for (const file of files) {
        if (this.trackedFiles.has(file)) continue
        if (this.isGitignored(file)) continue

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

    // Scan external directories for out-of-workspace files that were missed
    // by the Layer 1/2 pre-backup heuristics.
    // Skip shared system directories (e.g. /tmp) to avoid pulling in unrelated
    // files that other processes modified during the run.
    const externalDirs = this.collectExternalDirs()
    for (const dir of externalDirs) {
      if (isBlacklistedExternalDir(dir)) continue
      try {
        const files = await globFiles(dir, 2, SCAN_IGNORE)
        for (const file of files) {
          if (this.trackedFiles.has(file)) continue

          try {
            const fileStat = await stat(file)
            if (fileStat.mtimeMs >= this.runStartTime) {
              this.trackedFiles.set(file, null)
            }
          } catch {
            // Skip files we can't stat
          }
        }
      } catch (err) {
        console.error(`[snapshot] External scan failed for ${dir}:`, err)
      }
    }
  }

  /** Collect unique parent directories of tracked out-of-workspace files. */
  private collectExternalDirs(): string[] {
    const dirs = new Set<string>()
    const forbiddenRoots = new Set([resolve('/'), resolve(homedir())])

    for (const absolutePath of this.trackedFiles.keys()) {
      const rel = relative(this.workspacePath, absolutePath)
      if (rel.startsWith('..') || rel === absolutePath) {
        const dir = dirname(absolutePath)
        if (!forbiddenRoots.has(resolve(dir))) {
          dirs.add(dir)
        }
      }
    }

    return [...dirs]
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

    // Merge entries from a prior steer leg of the same run so that
    // mid-steer snapshot writes don't overwrite earlier file baselines.
    const priorSnapshot = await loadSnapshotIndex(this.workspaceHash, this.runId)
    if (priorSnapshot) {
      const currentByPath = new Map(entries.map((e) => [e.relativePath, e]))
      for (const priorEntry of priorSnapshot.entries) {
        const current = currentByPath.get(priorEntry.relativePath)
        if (current) {
          // File changed in both legs — keep the original backup from the prior leg.
          current.backupHash = priorEntry.backupHash
          current.originalSize = priorEntry.originalSize
        } else {
          // File changed only pre-steer — re-read to get the current after-state.
          const absPath = resolve(this.workspacePath, priorEntry.relativePath)
          let afterHash: string | null = null
          try {
            const content = await readFile(absPath)
            afterHash = hashContent(content)
            await storeBlob(this.workspaceHash, content)
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
              afterHash = null
            } else {
              continue
            }
          }
          // Skip if the file reverted to its original state.
          if (afterHash === priorEntry.backupHash) continue
          entries.push({ ...priorEntry, afterHash })
        }
      }
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

    await this.ensureGitignore()
    const files = await globFiles(this.workspacePath, SCAN_DEPTH, SCAN_IGNORE, signal)
    if (signal.aborted) return

    for (const file of files) {
      if (signal.aborted) return
      if (this.isGitignored(file)) continue

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
