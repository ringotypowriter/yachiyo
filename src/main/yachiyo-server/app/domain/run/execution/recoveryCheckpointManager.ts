import { performance } from 'node:perf_hooks'

import type { MessageTextBlockRecord } from '../../../../../../shared/yachiyo/protocol.ts'
import type { RunPerfCollector } from '../../../../services/perfMonitor.ts'
import type { RunRecoveryCheckpoint } from '../../../../storage/storage.ts'
import type { RecoveryResponseMessage } from '../runRecovery.ts'
import { upsertRunRecoveryCheckpoint } from './recoveryCheckpoint.ts'
import type { ExecuteRunInput, RunExecutionDeps } from './runExecutionTypes.ts'

interface RecoveryCheckpointSnapshot {
  content: string
  textBlocks: MessageTextBlockRecord[]
  reasoning?: string
  responseMessages: RecoveryResponseMessage[]
}

export interface PersistRecoveryCheckpointOptions {
  lastError?: string
  recoveryAttempts?: number
}

export interface RecoveryCheckpointManager {
  persist: (options?: PersistRecoveryCheckpointOptions) => RunRecoveryCheckpoint | undefined
  persistThrottled: () => void
}

export function createRecoveryCheckpointManager(input: {
  deps: RunExecutionDeps
  executionInput: ExecuteRunInput
  getSnapshot: () => RecoveryCheckpointSnapshot
  messageId: string
  perfCollector: RunPerfCollector
  recoveryCheckpoint?: RunRecoveryCheckpoint
}): RecoveryCheckpointManager {
  const recoveryCreatedAt = input.recoveryCheckpoint?.createdAt ?? input.deps.timestamp()
  const streamStartedAtMs = Date.now()
  let lastCheckpointPersistAtMs = 0

  const persist = (
    options: PersistRecoveryCheckpointOptions = {}
  ): RunRecoveryCheckpoint | undefined => {
    if (!input.executionInput.requestMessageId) {
      return undefined
    }

    const snapshot = input.getSnapshot()
    const checkpoint: RunRecoveryCheckpoint = {
      runId: input.executionInput.runId,
      threadId: input.executionInput.thread.id,
      requestMessageId: input.executionInput.requestMessageId,
      assistantMessageId: input.messageId,
      content: snapshot.content,
      ...(snapshot.textBlocks.length > 0 ? { textBlocks: snapshot.textBlocks } : {}),
      ...(snapshot.reasoning ? { reasoning: snapshot.reasoning } : {}),
      ...(snapshot.responseMessages.length > 0
        ? { responseMessages: snapshot.responseMessages }
        : {}),
      enabledTools: [...input.executionInput.enabledTools],
      ...(input.executionInput.enabledSkillNames
        ? { enabledSkillNames: [...input.executionInput.enabledSkillNames] }
        : {}),
      ...(input.executionInput.reasoningEffort !== undefined
        ? { reasoningEffort: input.executionInput.reasoningEffort }
        : {}),
      runTrigger: input.executionInput.runTrigger,
      ...(input.executionInput.channelHint
        ? { channelHint: input.executionInput.channelHint }
        : {}),
      updateHeadOnComplete: input.executionInput.updateHeadOnComplete,
      createdAt: recoveryCreatedAt,
      updatedAt: input.deps.timestamp(),
      recoveryAttempts: options.recoveryAttempts ?? input.recoveryCheckpoint?.recoveryAttempts ?? 0,
      ...(options.lastError ? { lastError: options.lastError } : {})
    }
    const cpStart = performance.now()
    upsertRunRecoveryCheckpoint(input.deps, checkpoint)
    input.perfCollector.recordCheckpointWrite(performance.now() - cpStart)
    lastCheckpointPersistAtMs = Date.now()
    return checkpoint
  }

  const persistThrottled = (): void => {
    const elapsedMs = Date.now() - streamStartedAtMs
    let minInterval = 750
    if (elapsedMs > 45000) {
      minInterval = 3000
    } else if (elapsedMs > 15000) {
      minInterval = 1500
    }
    if (Date.now() - lastCheckpointPersistAtMs < minInterval) {
      return
    }
    persist()
  }

  return {
    persist,
    persistThrottled
  }
}
