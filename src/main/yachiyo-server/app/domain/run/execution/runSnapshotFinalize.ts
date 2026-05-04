import { performance } from 'node:perf_hooks'

import { runGc } from '../../../../services/fileSnapshot/snapshotGc.ts'
import type { SnapshotTracker } from '../../../../services/fileSnapshot/snapshotTracker.ts'
import type { RunPerfCollector } from '../../../../services/perfMonitor.ts'
import type { SnapshotReadyEvent } from '../../../../../../shared/yachiyo/protocol.ts'
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
    runGc(snapshotTracker.workspaceHash).catch(() => {})
  } catch (error) {
    input.onError?.(error)
  } finally {
    input.perfCollector?.recordSnapshotFinalize(performance.now() - startedAt)
    snapshotTracker.dispose()
  }
}
