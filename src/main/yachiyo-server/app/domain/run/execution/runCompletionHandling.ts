import type {
  MessageCompletedEvent,
  MessageTextBlockRecord,
  ProviderSettings,
  RunCompletedEvent,
  ThreadRecord,
  ThreadUpdatedEvent
} from '../../../../../../shared/yachiyo/protocol.ts'
import type { ModelUsage } from '../../../../runtime/models/types.ts'
import type { SnapshotTracker } from '../../../../services/fileSnapshot/snapshotTracker.ts'
import type { RunPerfCollector } from '../../../../services/perfMonitor.ts'
import { createRunEventMetadata } from '../../shared/runEventMetadata.ts'
import type { RecoveryResponseMessage } from '../runRecovery.ts'
import { balanceResponseMessages } from '../context/runHistory.ts'
import { bindCompletedToolCallsToAssistant } from '../tools/toolCallLifecycle.ts'
import { finalizeRunSnapshot } from './runSnapshotFinalize.ts'
import { mergeRunUsage } from './runUsage.ts'
import { buildAssistantMessage, persistThreadAssistantMessage } from './terminalPersistence.ts'
import type { RunToolLifecycleState } from './runToolLifecycleState.ts'
import type { ExecuteRunInput, ExecuteRunResult, RunExecutionDeps } from './runExecutionTypes.ts'

interface RunCompletionOutputSnapshot {
  content: string
  reasoning?: string
  textBlocks: MessageTextBlockRecord[]
  recoveryResponseMessages: RecoveryResponseMessage[]
}

interface HandleCompletedRunInput {
  bindCurrentRunToolCallsToAssistant: (assistantMessageId: string) => void
  deps: RunExecutionDeps
  executionInput: ExecuteRunInput
  getOutputSnapshot: () => RunCompletionOutputSnapshot
  hasPendingSteer?: () => boolean
  lastUsage?: ModelUsage
  messageId: string
  perfCollector: RunPerfCollector
  recoveredFromCheckpoint: boolean
  settings: ProviderSettings
  snapshotTracker: SnapshotTracker | null
  toolLifecycle: RunToolLifecycleState
}

export async function handleCompletedRun(
  input: HandleCompletedRunInput
): Promise<ExecuteRunResult> {
  const snapshot = input.getOutputSnapshot()

  if (input.hasPendingSteer?.()) {
    return persistSteerPendingRun(input, snapshot)
  }

  return persistCompletedRun(input, snapshot)
}

async function persistSteerPendingRun(
  input: HandleCompletedRunInput,
  snapshot: RunCompletionOutputSnapshot
): Promise<ExecuteRunResult> {
  const timestamp = input.deps.timestamp()
  const rawResponseMessages =
    input.lastUsage?.responseMessages ??
    (snapshot.recoveryResponseMessages.length > 0 ? snapshot.recoveryResponseMessages : undefined)
  const responseMessages = rawResponseMessages
    ? balanceResponseMessages(rawResponseMessages)
    : rawResponseMessages
  const { assistantMessage } = persistThreadAssistantMessage(input.deps, {
    threadId: input.executionInput.thread.id,
    messageId: input.messageId,
    requestMessageId: input.executionInput.requestMessageId,
    timestamp,
    settings: input.settings,
    status: 'completed',
    content: snapshot.content,
    textBlocks: snapshot.textBlocks,
    ...(snapshot.reasoning ? { reasoning: snapshot.reasoning } : {}),
    ...(responseMessages ? { responseMessages } : {}),
    resolveUpdatedThread: (thread) => thread
  })
  await input.deps.onAssistantMessagePersisted?.(assistantMessage.id)
  input.deps.emit<MessageCompletedEvent>({
    type: 'message.completed',
    threadId: input.executionInput.thread.id,
    runId: input.executionInput.runId,
    message: assistantMessage
  })
  input.bindCurrentRunToolCallsToAssistant(input.messageId)
  input.deps.storage.deleteRunRecoveryCheckpoint(input.executionInput.runId)
  return {
    kind: 'steer-pending',
    assistantMessageId: input.messageId,
    usage: input.lastUsage,
    snapshotTracker: input.snapshotTracker ?? undefined,
    toolFailLoopSteersInjected: input.toolLifecycle.getToolFailLoopSteersInjected()
  }
}

async function persistCompletedRun(
  input: HandleCompletedRunInput,
  snapshot: RunCompletionOutputSnapshot
): Promise<ExecuteRunResult> {
  const timestamp = input.deps.timestamp()
  const responseMessages = input.recoveredFromCheckpoint
    ? snapshot.recoveryResponseMessages.length > 0
      ? snapshot.recoveryResponseMessages
      : undefined
    : input.lastUsage?.responseMessages
  const assistantMessage = buildAssistantMessage({
    threadId: input.executionInput.thread.id,
    messageId: input.messageId,
    requestMessageId: input.executionInput.requestMessageId,
    timestamp,
    settings: input.settings,
    status: 'completed',
    content: snapshot.content,
    textBlocks: snapshot.textBlocks,
    ...(snapshot.reasoning ? { reasoning: snapshot.reasoning } : {}),
    ...(responseMessages ? { responseMessages } : {})
  })
  const currentThread = input.deps.readThread(input.executionInput.thread.id)
  const updatedThread: ThreadRecord = {
    ...currentThread,
    updatedAt: timestamp,
    ...(input.executionInput.updateHeadOnComplete
      ? { preview: assistantMessage.content.slice(0, 240) }
      : currentThread.preview
        ? { preview: currentThread.preview }
        : {}),
    ...(input.executionInput.updateHeadOnComplete
      ? { headMessageId: assistantMessage.id }
      : currentThread.headMessageId
        ? { headMessageId: currentThread.headMessageId }
        : {})
  }

  const finalUsage = mergeRunUsage(input.executionInput.priorUsage, input.lastUsage)
  input.deps.onExecutionPhaseChange?.('terminal')
  input.deps.storage.completeRun({
    runId: input.executionInput.runId,
    updatedThread,
    assistantMessage,
    ...finalUsage,
    modelId: input.settings.model,
    providerName: input.settings.providerName
  })
  await input.deps.onAssistantMessagePersisted?.(assistantMessage.id)

  input.deps.emit<MessageCompletedEvent>({
    type: 'message.completed',
    threadId: input.executionInput.thread.id,
    runId: input.executionInput.runId,
    message: assistantMessage
  })
  bindCompletedToolCallsToAssistant(input.deps, input.toolLifecycle.toolCalls, {
    threadId: input.executionInput.thread.id,
    runId: input.executionInput.runId,
    assistantMessageId: assistantMessage.id
  })
  input.deps.emit<ThreadUpdatedEvent>({
    type: 'thread.updated',
    threadId: input.executionInput.thread.id,
    thread: updatedThread
  })
  await finalizeRunSnapshot({
    deps: input.deps,
    runId: input.executionInput.runId,
    snapshotTracker: input.snapshotTracker,
    threadId: input.executionInput.thread.id,
    perfCollector: input.perfCollector,
    onError: (error) => {
      console.error('[snapshot] Finalization failed:', error)
    }
  })

  input.deps.onTerminalState?.()
  input.deps.emit<RunCompletedEvent>({
    type: 'run.completed',
    ...createRunEventMetadata({
      threadId: input.executionInput.thread.id,
      runId: input.executionInput.runId,
      requestMessageId: input.executionInput.requestMessageId,
      runTrigger: input.executionInput.runTrigger
    }),
    ...finalUsage
  })
  input.perfCollector.finish(input.executionInput.thread.id)

  const usedRememberTool = input.toolLifecycle
    .getAllToolCalls()
    .some((tc) => tc.toolName === 'remember' && tc.status === 'completed' && !tc.error)
  return {
    kind: 'completed',
    totalPromptTokens: finalUsage?.totalPromptTokens,
    usedRememberTool
  }
}
