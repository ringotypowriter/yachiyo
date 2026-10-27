import type { YachiyoStorage } from '../../../storage/storage.ts'
import type {
  WorkerTranscriptCompaction,
  WorkerTranscriptEntry,
  WorkerTranscriptTurn
} from '../../../storage/workerTranscripts.ts'
import type {
  LaunchSubagentInput,
  SubagentRunnerTurnInput,
  SubagentTurnResult
} from './subagentManager.ts'
import { SubagentTurnError } from './subagentManager.ts'

export interface WorkerTranscriptRecorder {
  append(messages: readonly unknown[], isMeta?: boolean): void
  update(messages: readonly unknown[], eager?: boolean): void
  commit(messages: readonly unknown[]): void
  compact(compaction: WorkerTranscriptCompaction): void
  finish(result: SubagentTurnResult): void
  fail(error: unknown, cancelled: boolean): void
}

export function createWorkerTranscriptRecorder(input: {
  storage: Pick<YachiyoStorage, 'upsertWorkerTranscriptTurn'>
  launch: LaunchSubagentInput
  turn: SubagentRunnerTurnInput
  modelId: string
  timestamp?: () => string
}): WorkerTranscriptRecorder {
  const timestamp = input.timestamp ?? (() => new Date().toISOString())
  const createdAt = timestamp()
  const entries: WorkerTranscriptEntry[] = []
  let pending: readonly unknown[] = []
  let pendingAt = createdAt
  let lastFlush = 0
  const record: WorkerTranscriptTurn = {
    id: JSON.stringify([input.launch.agentId, input.turn.turnId]),
    version: 1,
    agentId: input.launch.agentId,
    threadId: input.launch.parentThreadId,
    launchRunId: input.launch.launchRunId,
    turnId: input.turn.turnId,
    agentType: input.launch.agentType,
    workspacePath: input.launch.workspacePath,
    modelId: input.modelId,
    messages: [],
    compaction: null,
    status: 'running',
    error: null,
    promptTokens: null,
    completionTokens: null,
    createdAt,
    updatedAt: createdAt,
    completedAt: null
  }
  const flush = (): void => {
    record.updatedAt = timestamp()
    record.messages = [
      ...entries,
      ...pending.map((message) => ({ message, timestamp: pendingAt, isMeta: false }))
    ]
    input.storage.upsertWorkerTranscriptTurn(record)
    lastFlush = Date.now()
  }
  return {
    append(messages, isMeta = false) {
      const at = timestamp()
      entries.push(
        ...messages.map((message) => ({ message: structuredClone(message), timestamp: at, isMeta }))
      )
      flush()
    },
    update(messages, eager = true) {
      if (pending.length === 0) pendingAt = timestamp()
      pending = messages
      if (eager || Date.now() - lastFlush >= 750) flush()
    },
    commit(messages) {
      entries.push(
        ...messages.map((message) => ({
          message: structuredClone(message),
          timestamp: pendingAt,
          isMeta: false
        }))
      )
      pending = []
      flush()
    },
    compact(compaction) {
      record.compaction = compaction
      flush()
    },
    finish(result) {
      record.status = 'completed'
      record.promptTokens = result.promptTokens ?? null
      record.completionTokens = result.completionTokens ?? null
      record.completedAt = timestamp()
      flush()
    },
    fail(error, cancelled) {
      record.status = cancelled ? 'cancelled' : 'failed'
      record.error = error instanceof Error ? error.message : String(error)
      if (error instanceof SubagentTurnError) {
        record.promptTokens = error.usage.promptTokens ?? null
        record.completionTokens = error.usage.completionTokens ?? null
      }
      record.completedAt = timestamp()
      flush()
    }
  }
}
