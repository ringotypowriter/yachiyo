import { performance } from 'node:perf_hooks'

import { runGc } from '../../../../services/fileSnapshot/snapshotGc.ts'
import type { SnapshotTracker } from '../../../../services/fileSnapshot/snapshotTracker.ts'
import type { RunPerfCollector } from '../../../../services/perfMonitor.ts'
import type { YachiyoStorage } from '../../../../storage/storage.ts'
import type { SnapshotReadyEvent } from '@yachiyo/shared/protocol'
import type { RunExecutionDeps } from './runExecutionTypes.ts'

export interface FinalizeRunSnapshotInput {
  deps: RunExecutionDeps
  runId: string
  threadId: string
  snapshotTracker: SnapshotTracker | null
  perfCollector?: RunPerfCollector
  onError?: (error: unknown) => void
}

export async function finalizeRunSnapshot(input: FinalizeRunSnapshotInput): Promise<void> {
  const { deps, runId, snapshotTracker, threadId } = input
  if (!snapshotTracker) {
    return
  }

  const startedAt = performance.now()
  try {
    await snapshotTracker.scanWorkspace()
    const snapshot = await snapshotTracker.finalize()
    deps.storage.updateRunSnapshot(runId, {
      fileCount: snapshot.entries.length,
      workspacePath: snapshotTracker.workspacePath
    })
    deps.emit<SnapshotReadyEvent>({
      type: 'snapshot.ready',
      threadId,
      runId,
      fileCount: snapshot.entries.length,
      workspacePath: snapshotTracker.workspacePath
    })
    expireRunSnapshots(
      deps.storage,
      snapshotTracker.workspaceHash,
      snapshotTracker.workspacePath
    ).catch(() => {})
  } catch (error) {
    input.onError?.(error)
  } finally {
    input.perfCollector?.recordSnapshotFinalize(performance.now() - startedAt)
    snapshotTracker.dispose()
  }
}

/**
 * Applies snapshot retention and clears the file counts of runs whose snapshots
 * it removed, so their footers stop offering a review that can no longer load.
 */
export async function expireRunSnapshots(
  storage: Pick<YachiyoStorage, 'updateRunSnapshot'>,
  workspaceHash: string,
  workspacePath: string
): Promise<void> {
  for (const runId of await runGc(workspaceHash)) {
    storage.updateRunSnapshot(runId, { fileCount: 0, workspacePath })
  }
}
