import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import { resolveYachiyoFileHistoryDir } from '../../config/paths.ts'
import type { RunSnapshot, SnapshotSummary } from '../../../../shared/yachiyo/fileSnapshot.ts'

function snapshotsDir(workspaceHash: string): string {
  return join(resolveYachiyoFileHistoryDir(), workspaceHash, 'snapshots')
}

function snapshotPath(workspaceHash: string, runId: string): string {
  return join(snapshotsDir(workspaceHash), `${runId}.json`)
}

/** Persist a run snapshot to disk atomically (write tmp → rename). */
export async function saveSnapshotIndex(
  workspaceHash: string,
  snapshot: RunSnapshot
): Promise<void> {
  const dir = snapshotsDir(workspaceHash)
  await mkdir(dir, { recursive: true })
  const dest = snapshotPath(workspaceHash, snapshot.runId)
  const tmp = `${dest}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, JSON.stringify(snapshot), 'utf8')
  await rename(tmp, dest)
}

/** Load a specific run snapshot, or null if not found. */
export async function loadSnapshotIndex(
  workspaceHash: string,
  runId: string
): Promise<RunSnapshot | null> {
  try {
    const raw = await readFile(snapshotPath(workspaceHash, runId), 'utf8')
    return JSON.parse(raw) as RunSnapshot
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** List all snapshot summaries for a workspace, sorted newest-first. */
export async function listSnapshotRuns(workspaceHash: string): Promise<SnapshotSummary[]> {
  const dir = snapshotsDir(workspaceHash)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  const summaries: SnapshotSummary[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = await readFile(join(dir, file), 'utf8')
      const snapshot = JSON.parse(raw) as RunSnapshot
      summaries.push({
        runId: snapshot.runId,
        fileCount: snapshot.entries.length,
        createdAt: snapshot.createdAt
      })
    } catch {
      // Skip malformed snapshot files
    }
  }

  summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return summaries
}

/** Return the number of snapshot files for a workspace (cheap readdir). */
export async function countSnapshots(workspaceHash: string): Promise<number> {
  try {
    const files = await readdir(snapshotsDir(workspaceHash))
    return files.filter((f) => f.endsWith('.json')).length
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
    throw err
  }
}

/** Delete a specific snapshot index file. */
export async function deleteSnapshotIndex(workspaceHash: string, runId: string): Promise<void> {
  try {
    await unlink(snapshotPath(workspaceHash, runId))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
