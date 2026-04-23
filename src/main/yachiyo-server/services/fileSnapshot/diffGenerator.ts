import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createTwoFilesPatch } from 'diff'

import type {
  FileChangeForReview,
  FileSnapshotEntry
} from '../../../../shared/yachiyo/fileSnapshot.ts'
import { hashWorkspacePath, readBlob } from './casStore.ts'
import { deleteSnapshotIndex, listSnapshotRuns, loadSnapshotIndex } from './snapshotIndex.ts'

// ---------------------------------------------------------------------------
// Unified diff generation (Myers algorithm via `diff` package)
// ---------------------------------------------------------------------------

/** Strip the `Index:` and `===` header lines that `createTwoFilesPatch` prepends. */
function stripIndexHeader(patch: string): string {
  return patch.replace(/^Index:.*\n={10,}\n/, '')
}

function buildUnifiedDiff(filePath: string, oldContent: string, newContent: string): string {
  return stripIndexHeader(
    createTwoFilesPatch(filePath, filePath, oldContent, newContent, '', '', { context: 3 })
  )
}

function buildCreatedDiff(filePath: string, content: string): string {
  return stripIndexHeader(
    createTwoFilesPatch('/dev/null', filePath, '', content, '', '', { context: 3 })
  )
}

function buildDeletedDiff(filePath: string, content: string): string {
  return stripIndexHeader(
    createTwoFilesPatch(filePath, '/dev/null', content, '', '', '', { context: 3 })
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a CAS blob, returning null (with a warning) when the blob file is
 * missing. A single orphaned blob must not blank the whole diff view.
 */
async function readBlobSafe(
  workspaceHash: string,
  hash: string,
  relativePath: string,
  kind: 'backup' | 'after'
): Promise<string | null> {
  try {
    return (await readBlob(workspaceHash, hash)).toString('utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.warn(
        `[snapshot] Missing ${kind} blob for ${relativePath} (hash ${hash.slice(0, 12)}…); entry will be marked unavailable.`
      )
      return null
    }
    throw err
  }
}

const UNAVAILABLE_PLACEHOLDER = '<< original content unavailable — backup blob was pruned >>\n'

/**
 * Generate file-by-file diffs for a completed run.
 *
 * For the latest run, compares each tracked file against the current workspace
 * state so reverted files disappear from the diff. For historical runs, uses the
 * stored `afterHash` from the snapshot so that later runs' edits are not
 * attributed to this run.
 */
export async function generateDiffForRun(
  workspacePath: string,
  runId: string
): Promise<FileChangeForReview[]> {
  const workspaceHash = hashWorkspacePath(workspacePath)
  const snapshot = await loadSnapshotIndex(workspaceHash, runId)
  if (!snapshot) return []

  // Determine whether this is the latest snapshot so we know whether to read
  // the current workspace (live diffing) or the stored after-state (historical).
  const allSnapshots = await listSnapshotRuns(workspaceHash)
  const isLatest =
    allSnapshots.length > 0 &&
    allSnapshots.reduce((newest, s) => (s.createdAt > newest.createdAt ? s : newest)).runId ===
      runId

  const changes: FileChangeForReview[] = []

  for (const entry of snapshot.entries) {
    let beforeContent: string | null = null
    let beforeUnavailable = false
    if (entry.backupHash) {
      beforeContent = await readBlobSafe(
        workspaceHash,
        entry.backupHash,
        entry.relativePath,
        'backup'
      )
      if (beforeContent === null) beforeUnavailable = true
    }

    let afterContent: string | null = null
    if (isLatest) {
      // Live diff: read current workspace so reverted files disappear.
      const absolutePath = join(workspacePath, entry.relativePath)
      try {
        afterContent = await readFile(absolutePath, 'utf8')
      } catch {
        afterContent = null
      }
    } else if (entry.afterHash) {
      // Historical diff: use the stored after-state from when the run completed.
      afterContent = await readBlobSafe(workspaceHash, entry.afterHash, entry.relativePath, 'after')
    }

    // If the file has been restored to its pre-run state, fall back to the
    // stored afterHash so the diff shows what the agent originally changed.
    if (!beforeUnavailable && beforeContent === afterContent) {
      if (isLatest && entry.afterHash) {
        const storedAfter = await readBlobSafe(
          workspaceHash,
          entry.afterHash,
          entry.relativePath,
          'after'
        )
        if (storedAfter !== null && storedAfter !== beforeContent) {
          changes.push({
            relativePath: entry.relativePath,
            status: beforeContent === null ? 'created' : 'modified',
            diff:
              beforeContent === null
                ? buildCreatedDiff(entry.relativePath, storedAfter)
                : buildUnifiedDiff(entry.relativePath, beforeContent, storedAfter),
            reverted: true
          })
        }
      }
      continue
    }

    if (beforeUnavailable) {
      // Original blob was pruned. Surface the current content with a banner
      // instead of dropping the whole entry (and blanking the modal).
      const rendered = afterContent ?? ''
      changes.push({
        relativePath: entry.relativePath,
        status: 'modified',
        diff: buildUnifiedDiff(entry.relativePath, UNAVAILABLE_PLACEHOLDER, rendered)
      })
    } else if (beforeContent === null && afterContent !== null) {
      changes.push({
        relativePath: entry.relativePath,
        status: 'created',
        diff: buildCreatedDiff(entry.relativePath, afterContent)
      })
    } else if (beforeContent !== null && afterContent === null) {
      changes.push({
        relativePath: entry.relativePath,
        status: 'deleted',
        diff: buildDeletedDiff(entry.relativePath, beforeContent)
      })
    } else if (beforeContent !== null && afterContent !== null && beforeContent !== afterContent) {
      changes.push({
        relativePath: entry.relativePath,
        status: 'modified',
        diff: buildUnifiedDiff(entry.relativePath, beforeContent, afterContent)
      })
    }
  }

  return changes
}

/** Revert a single file to its pre-run state. */
export async function revertFile(
  workspacePath: string,
  runId: string,
  relativePath: string
): Promise<void> {
  const workspaceHash = hashWorkspacePath(workspacePath)
  const snapshot = await loadSnapshotIndex(workspaceHash, runId)
  if (!snapshot) return

  const entry = snapshot.entries.find((e) => e.relativePath === relativePath)
  if (!entry) return

  await revertEntry(workspacePath, workspaceHash, entry)
}

/** Revert all files in a run to their pre-run state. */
export async function revertRun(workspacePath: string, runId: string): Promise<void> {
  const workspaceHash = hashWorkspacePath(workspacePath)
  const snapshot = await loadSnapshotIndex(workspaceHash, runId)
  if (!snapshot) return

  for (const entry of snapshot.entries) {
    await revertEntry(workspacePath, workspaceHash, entry)
  }
}

/**
 * Restore workspace to a snapshot checkpoint.
 *
 * Reverts all runs from newest to the target in reverse chronological order,
 * so that every file touched by any later run is properly restored.
 * Then deletes all affected snapshots (non-reversible).
 *
 * Returns the list of run IDs whose snapshots were destroyed.
 */
export async function restoreToCheckpoint(workspacePath: string, runId: string): Promise<string[]> {
  const workspaceHash = hashWorkspacePath(workspacePath)
  const targetSnapshot = await loadSnapshotIndex(workspaceHash, runId)
  if (!targetSnapshot) return []

  // Collect all snapshots from newest to the target (inclusive), sorted newest-first
  const allSnapshots = await listSnapshotRuns(workspaceHash)
  const targetTime = targetSnapshot.createdAt
  const toRevert = allSnapshots
    .filter((s) => s.createdAt >= targetTime)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)) // newest first

  // Revert each run in reverse chronological order
  for (const snap of toRevert) {
    const snapshot = await loadSnapshotIndex(workspaceHash, snap.runId)
    if (!snapshot) continue
    for (const entry of snapshot.entries) {
      await revertEntry(workspacePath, workspaceHash, entry)
    }
  }

  // Delete all affected snapshots
  const destroyedRunIds: string[] = []
  for (const snap of toRevert) {
    await deleteSnapshotIndex(workspaceHash, snap.runId)
    destroyedRunIds.push(snap.runId)
  }

  // Run GC to clean up unreferenced blobs
  const { runGc } = await import('./snapshotGc.ts')
  await runGc(workspaceHash)

  return destroyedRunIds
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function revertEntry(
  workspacePath: string,
  workspaceHash: string,
  entry: FileSnapshotEntry
): Promise<void> {
  const absolutePath = join(workspacePath, entry.relativePath)

  if (entry.backupHash === null) {
    // File was newly created — delete it
    try {
      await unlink(absolutePath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  } else {
    // File was modified or deleted — restore original content.
    // Ensure parent directories exist (they may have been deleted).
    await mkdir(dirname(absolutePath), { recursive: true })
    const originalContent = await readBlob(workspaceHash, entry.backupHash)
    await writeFile(absolutePath, originalContent)
  }
}
