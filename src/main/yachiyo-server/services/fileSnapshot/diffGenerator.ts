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
 * Generate file-by-file diffs for a completed run.
 *
 * Uses the stored `afterHash` to produce accurate before→after diffs,
 * even when later runs have since modified the same files. Falls back
 * to comparing against the current workspace when `afterHash` is absent
 * (snapshots created before the afterHash feature).
 */
export async function generateDiffForRun(
  workspacePath: string,
  runId: string
): Promise<FileChangeForReview[]> {
  const workspaceHash = hashWorkspacePath(workspacePath)
  const snapshot = await loadSnapshotIndex(workspaceHash, runId)
  if (!snapshot) return []

  const changes: FileChangeForReview[] = []

  for (const entry of snapshot.entries) {
    const beforeContent = entry.backupHash
      ? (await readBlob(workspaceHash, entry.backupHash)).toString('utf8')
      : null

    // Use afterHash if available; fall back to current disk for legacy snapshots.
    let afterContent: string | null = null
    if (entry.afterHash !== undefined) {
      afterContent = entry.afterHash
        ? (await readBlob(workspaceHash, entry.afterHash)).toString('utf8')
        : null
    } else {
      // Legacy path: compare against current workspace
      const absolutePath = join(workspacePath, entry.relativePath)
      try {
        afterContent = await readFile(absolutePath, 'utf8')
      } catch {
        afterContent = null
      }
    }

    if (beforeContent === null && afterContent !== null) {
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
