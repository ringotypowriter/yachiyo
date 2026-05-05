import type {
  ToolCallRecord,
  ToolCallUpdatedEvent
} from '../../../../../../shared/yachiyo/protocol.ts'
import type { YachiyoStorage } from '../../../../storage/storage.ts'
import type { EmitServerEvent } from '../../shared/shared.ts'

export function finishPendingToolCalls(
  deps: {
    emit: EmitServerEvent
    storage: Pick<YachiyoStorage, 'updateToolCall'>
  },
  toolCalls: Map<string, ToolCallRecord>,
  input: { threadId: string; runId: string; finishedAt: string; error: string }
): void {
  for (const current of toolCalls.values()) {
    if (current.status !== 'preparing' && current.status !== 'running') {
      continue
    }

    const nextToolCall: ToolCallRecord = {
      ...current,
      status: 'failed',
      outputSummary: input.error,
      error: input.error,
      finishedAt: input.finishedAt
    }

    toolCalls.set(nextToolCall.id, nextToolCall)
    deps.storage.updateToolCall(nextToolCall)
    deps.emit<ToolCallUpdatedEvent>({
      type: 'tool.updated',
      threadId: input.threadId,
      runId: input.runId,
      toolCall: nextToolCall
    })
  }
}

export function bindCompletedToolCallsToAssistant(
  deps: {
    emit: EmitServerEvent
    loadThreadToolCalls: (threadId: string) => ToolCallRecord[]
  },
  toolCalls: Map<string, ToolCallRecord>,
  input: { threadId: string; runId: string; assistantMessageId: string }
): void {
  const persistedToolCalls = deps
    .loadThreadToolCalls(input.threadId)
    .filter(
      (toolCall) =>
        toolCall.runId === input.runId && toolCall.assistantMessageId === input.assistantMessageId
    )

  for (const persistedToolCall of persistedToolCalls) {
    toolCalls.set(persistedToolCall.id, persistedToolCall)
    deps.emit<ToolCallUpdatedEvent>({
      type: 'tool.updated',
      threadId: input.threadId,
      runId: input.runId,
      toolCall: persistedToolCall
    })
  }
}

export function bindRunToolCallsToAssistant(
  deps: {
    emit: EmitServerEvent
    updateToolCall: (toolCall: ToolCallRecord) => void
  },
  toolCalls: Map<string, ToolCallRecord>,
  input: { threadId: string; runId: string; assistantMessageId: string }
): void {
  for (const [toolCallId, toolCall] of toolCalls.entries()) {
    if (
      toolCall.runId !== input.runId ||
      toolCall.assistantMessageId === input.assistantMessageId
    ) {
      continue
    }

    const bound: ToolCallRecord = {
      ...toolCall,
      assistantMessageId: input.assistantMessageId
    }
    toolCalls.set(toolCallId, bound)
    deps.updateToolCall(bound)
    deps.emit<ToolCallUpdatedEvent>({
      type: 'tool.updated',
      threadId: input.threadId,
      runId: input.runId,
      toolCall: bound
    })
  }
}

export function restorePersistedRunToolCalls(
  loadThreadToolCalls: (threadId: string) => ToolCallRecord[],
  threadId: string,
  runId: string
): Map<string, ToolCallRecord> {
  return new Map(
    loadThreadToolCalls(threadId)
      .filter((toolCall) => toolCall.runId === runId)
      .map((toolCall) => [toolCall.id, toolCall] as const)
  )
}
