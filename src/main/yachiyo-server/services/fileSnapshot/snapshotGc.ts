import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveYachiyoFileHistoryDir } from '../../config/paths.ts'
import type { RunSnapshot } from '../../../../shared/yachiyo/fileSnapshot.ts'
import { deleteBlob } from './casStore.ts'
import { deleteSnapshotIndex } from './snapshotIndex.ts'

/** Maximum number of snapshots to retain per workspace. */
const MAX_SNAPSHOTS = 20
/** Maximum age in milliseconds (7 days). */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Run garbage collection for a workspace's snapshots and backup blobs.
 *
 * Two phases:
 * 1. Retention: delete snapshots beyond the retention window (newest 20 or 7 days).
 * 2. Orphan sweep: delete backup blobs not referenced by any surviving snapshot.
 *    This phase runs unconditionally so that blobs orphaned by restoreToCheckpoint
 *    or other snapshot deletions are always reclaimed.
 */
export async function runGc(workspaceHash: string): Promise<void> {
  const snapshotsDir = join(resolveYachiyoFileHistoryDir(), workspaceHash, 'snapshots')
  const backupsDir = join(resolveYachiyoFileHistoryDir(), workspaceHash, 'backups')

  // Load all snapshot files
  let files: string[]
  try {
    files = await readdir(snapshotsDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No snapshots dir — still sweep orphan blobs if backups dir exists
      await sweepOrphanBlobs(workspaceHash, backupsDir, new Set())
      return
    }
    throw err
  }

  const snapshots: RunSnapshot[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = await readFile(join(snapshotsDir, file), 'utf8')
      snapshots.push(JSON.parse(raw) as RunSnapshot)
    } catch {
      // Skip malformed files
    }
  }

  // Phase 1: Retention-based snapshot deletion
  snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt))

  const now = Date.now()
  const cutoffTime = now - MAX_AGE_MS
  const toKeep = new Set<string>()

  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i]!
    const age = new Date(s.createdAt).getTime()
    if (i < MAX_SNAPSHOTS && age >= cutoffTime) {
      toKeep.add(s.runId)
    }
  }

  for (const s of snapshots) {
    if (!toKeep.has(s.runId)) {
      await deleteSnapshotIndex(workspaceHash, s.runId)
    }
  }

  // Remove deleted snapshots from the working set
  const surviving = snapshots.filter((s) => toKeep.has(s.runId))
  snapshots.length = 0
  snapshots.push(...surviving)

  // Phase 2: Orphan blob sweep (always runs)
  const referencedHashes = new Set<string>()
  for (const s of snapshots) {
    for (const entry of s.entries) {
      if (entry.backupHash) referencedHashes.add(entry.backupHash)
      if (entry.afterHash) referencedHashes.add(entry.afterHash)
    }
  }

  await sweepOrphanBlobs(workspaceHash, backupsDir, referencedHashes)
}

async function sweepOrphanBlobs(
  workspaceHash: string,
  backupsDir: string,
  referencedHashes: Set<string>
): Promise<void> {
  let blobFiles: string[]
  try {
    blobFiles = await readdir(backupsDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }

  for (const blobFile of blobFiles) {
    if (!referencedHashes.has(blobFile)) {
      await deleteBlob(workspaceHash, blobFile)
    }
  }
}
