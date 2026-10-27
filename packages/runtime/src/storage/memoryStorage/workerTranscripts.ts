import type { YachiyoStorage } from '../storage.ts'
import type { WorkerTranscriptTurn } from '../workerTranscripts.ts'

interface WorkerTranscriptStore {
  methods: Pick<YachiyoStorage, 'upsertWorkerTranscriptTurn' | 'listWorkerTranscriptTurns'>
  deleteRuns(runIds: ReadonlySet<string>): void
  recover(input: { error: string; finishedAt: string }): void
}

export function createInMemoryWorkerTranscriptStore(
  canRecord: (turn: WorkerTranscriptTurn) => boolean
): WorkerTranscriptStore {
  const turns = new Map<string, WorkerTranscriptTurn>()
  return {
    methods: {
      upsertWorkerTranscriptTurn(turn) {
        if (!canRecord(turn)) return false
        turns.set(turn.id, structuredClone(turn))
        return true
      },
      listWorkerTranscriptTurns(threadId) {
        return [...turns.values()]
          .filter((turn) => turn.threadId === threadId)
          .sort(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
          )
          .map((turn) => structuredClone(turn))
      }
    },
    deleteRuns(runIds) {
      for (const [id, turn] of turns) {
        if (runIds.has(turn.launchRunId)) turns.delete(id)
      }
    },
    recover({ error, finishedAt }) {
      for (const turn of turns.values()) {
        if (turn.status !== 'running') continue
        turn.status = 'failed'
        turn.error = error
        turn.updatedAt = finishedAt
        turn.completedAt = finishedAt
      }
    }
  }
}
