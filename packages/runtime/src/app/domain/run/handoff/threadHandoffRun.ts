import type {
  ComposerReasoningSelection,
  MessageCompletedEvent,
  MessageDeltaEvent,
  MessageReasoningDeltaEvent,
  MessageRecord,
  MessageStartedEvent,
  RunCancelledEvent,
  RunCompletedEvent,
  RunFailedEvent,
  RunUsageUpdatedEvent,
  ThreadRecord,
  ThreadUpdatedEvent
} from '@yachiyo/shared/protocol'
import { summarizeMessagePreview } from '@yachiyo/shared/messageContent'
import { buildThreadHandoffPrompt } from '../../../../runtime/context/threadHandoff.ts'
import type { ModelUsage } from '../../../../runtime/models/types.ts'
import { toEffectiveProviderSettings } from '../../../../settings/settingsStore.ts'
import { createRunEventMetadata } from '../../shared/runEventMetadata.ts'
import { createDeltaBatcher, DEFAULT_THREAD_TITLE } from '../../shared/shared.ts'
import { buildTitleQuery, deriveThreadTitleFallback } from '../../threads/threadTitle.ts'
import type { RunDomainDeps, RunState } from '../runTypes.ts'
import type { ThreadTitleGenerationRunner } from '../title/threadTitleGeneration.ts'
import { prepareThreadHandoffContext } from './threadHandoffContext.ts'

export interface StreamCompactThreadHandoffContext {
  deps: RunDomainDeps
  activeRuns: Map<string, RunState>
  activeRunByThread: Map<string, string>
  activeRunTasks: Map<string, Promise<void>>
  threadTitleRunner: ThreadTitleGenerationRunner
}

export interface StreamCompactThreadHandoffInput {
  runId: string
  thread: ThreadRecord
  sourceThreadId: string
  sourceMessages: MessageRecord[]
  reasoningEffort?: ComposerReasoningSelection
}

export async function streamCompactThreadHandoff(
  context: StreamCompactThreadHandoffContext,
  input: StreamCompactThreadHandoffInput
): Promise<void> {
  const { activeRunByThread, activeRunTasks, activeRuns, deps, threadTitleRunner } = context
  const config = deps.readConfig()
  const settings = toEffectiveProviderSettings(config, input.thread.modelOverride)
  const runtime = deps.createModelRuntime()
  const messageId = deps.createId()
  const bufferParts: string[] = []
  const reasoningParts: string[] = []
  let reasoningLength = 0
  const DELTA_FLUSH_INTERVAL_MS = 20

  deps.emit<MessageStartedEvent>({
    type: 'message.started',
    threadId: input.thread.id,
    runId: input.runId,
    messageId
  })

  const activeRun = activeRuns.get(input.runId)
  if (!activeRun) {
    return
  }

  const textDeltaBatcher = createDeltaBatcher({
    intervalMs: DELTA_FLUSH_INTERVAL_MS,
    onFlush: (batch) => {
      bufferParts.push(batch)
      deps.emit<MessageDeltaEvent>({
        type: 'message.delta',
        threadId: input.thread.id,
        runId: input.runId,
        messageId,
        delta: batch
      })
    },
    isAborted: () => activeRun.abortController.signal.aborted
  })

  const reasoningDeltaBatcher = createDeltaBatcher({
    intervalMs: DELTA_FLUSH_INTERVAL_MS,
    onFlush: (batch) => {
      reasoningParts.push(batch)
      reasoningLength += batch.length
      deps.emit<MessageReasoningDeltaEvent>({
        type: 'message.reasoning.delta',
        threadId: input.thread.id,
        runId: input.runId,
        messageId,
        delta: batch
      })
    },
    isAborted: () => activeRun.abortController.signal.aborted
  })

  try {
    const sourceThread = deps.requireThread(input.sourceThreadId)
    const handoffContext = await prepareThreadHandoffContext({
      deps,
      sourceThread,
      sourceMessages: input.sourceMessages,
      requestContent: buildThreadHandoffPrompt(input.sourceMessages.length > 0),
      runId: input.runId,
      settings,
      config,
      abortController: activeRun.abortController
    })
    const { preparedContext } = handoffContext

    let handoffUsage: ModelUsage | undefined
    for await (const delta of runtime.streamReply({
      messages: preparedContext.messages,
      settings,
      signal: activeRun.abortController.signal,
      purpose: 'thread-handoff',
      promptCacheKey: input.sourceThreadId,
      ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(handoffContext.tools
        ? {
            tools: handoffContext.tools,
            stopWhen: handoffContext.stopWhen,
            onToolCallError: handoffContext.onToolCallError
          }
        : {}),
      onReasoningDelta: (reasoningDelta) => {
        reasoningDeltaBatcher.push(reasoningDelta)
      },
      onFinish: (usage) => {
        handoffUsage = usage
      }
    })) {
      if (!delta) {
        continue
      }

      textDeltaBatcher.push(delta)
    }

    textDeltaBatcher.flush()
    reasoningDeltaBatcher.flush()

    const timestamp = deps.timestamp()
    const handoffResponseMessages =
      !handoffContext.didRefuseToolExecution() && handoffUsage?.responseMessages
        ? (handoffUsage.responseMessages as Array<{ role?: string; content?: unknown[] }>)
            .map((msg) => {
              if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg
              return {
                ...msg,
                content: msg.content.filter(
                  (part) => (part as { type?: string }).type !== 'reasoning'
                )
              }
            })
            .filter(
              (msg) =>
                msg.role !== 'assistant' || !Array.isArray(msg.content) || msg.content.length > 0
            )
        : undefined

    const assistantMessage: MessageRecord = {
      id: messageId,
      threadId: input.thread.id,
      role: 'assistant',
      content: bufferParts.join(''),
      ...(reasoningLength > 0 ? { reasoning: reasoningParts.join('') } : {}),
      ...(handoffResponseMessages?.length ? { responseMessages: handoffResponseMessages } : {}),
      status: 'completed',
      createdAt: timestamp,
      modelId: settings.model,
      providerName: settings.providerName
    }
    const currentThread = deps.requireThread(input.thread.id)
    const firstMeaningfulMessage =
      currentThread.title === DEFAULT_THREAD_TITLE
        ? input.sourceMessages.find(
            (m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim()
          )
        : undefined
    const handoffFallbackTitle = firstMeaningfulMessage
      ? deriveThreadTitleFallback({
          content: firstMeaningfulMessage.content,
          ...('images' in firstMeaningfulMessage && firstMeaningfulMessage.images
            ? { images: firstMeaningfulMessage.images }
            : {})
        })
      : null
    const updatedThread: ThreadRecord = {
      ...currentThread,
      headMessageId: assistantMessage.id,
      preview: summarizeMessagePreview(assistantMessage).slice(0, 240),
      ...(handoffFallbackTitle ? { title: handoffFallbackTitle } : {}),
      updatedAt: timestamp
    }

    deps.storage.completeRun({
      runId: input.runId,
      updatedThread,
      assistantMessage,
      ...(handoffUsage
        ? {
            promptTokens: handoffUsage.completionTokens,
            completionTokens: handoffUsage.completionTokens,
            totalPromptTokens: handoffUsage.totalCompletionTokens,
            totalCompletionTokens: handoffUsage.totalCompletionTokens,
            ...(handoffUsage.cacheReadTokens != null
              ? { cacheReadTokens: handoffUsage.cacheReadTokens }
              : {}),
            ...(handoffUsage.cacheWriteTokens != null
              ? { cacheWriteTokens: handoffUsage.cacheWriteTokens }
              : {})
          }
        : {})
    })
    if (handoffUsage) {
      deps.emit<RunUsageUpdatedEvent>({
        type: 'run.usage.updated',
        threadId: input.thread.id,
        runId: input.runId,
        promptTokens: handoffUsage.completionTokens,
        completionTokens: handoffUsage.completionTokens
      })
    }

    deps.emit<MessageCompletedEvent>({
      type: 'message.completed',
      threadId: input.thread.id,
      runId: input.runId,
      message: assistantMessage
    })
    deps.emit<ThreadUpdatedEvent>({
      type: 'thread.updated',
      threadId: input.thread.id,
      thread: updatedThread
    })
    activeRuns.delete(input.runId)
    if (activeRunByThread.get(input.thread.id) === input.runId) {
      activeRunByThread.delete(input.thread.id)
    }
    activeRunTasks.delete(input.runId)
    deps.emit<RunCompletedEvent>({
      type: 'run.completed',
      ...createRunEventMetadata({
        threadId: input.thread.id,
        runId: input.runId,
        runTrigger: 'local'
      }),
      ...(handoffUsage
        ? {
            promptTokens: handoffUsage.completionTokens,
            completionTokens: handoffUsage.completionTokens,
            totalPromptTokens: handoffUsage.totalCompletionTokens,
            totalCompletionTokens: handoffUsage.totalCompletionTokens
          }
        : {})
    })

    if (handoffFallbackTitle && firstMeaningfulMessage?.content) {
      threadTitleRunner.schedule({
        fallbackTitle: handoffFallbackTitle,
        query: buildTitleQuery(
          firstMeaningfulMessage.content,
          firstMeaningfulMessage.images,
          firstMeaningfulMessage.attachments
        ),
        runId: input.runId,
        threadId: input.thread.id
      })
    }
  } catch (error) {
    // Drain buffered deltas so cancelled/failed handoff messages include all
    // already-received output, consistent with the main run path.
    textDeltaBatcher.flush()
    reasoningDeltaBatcher.flush()

    const timestamp = deps.timestamp()
    const message = error instanceof Error ? error.message : String(error)
    const wasAborted = activeRuns.get(input.runId)?.abortController.signal.aborted ?? false

    if (wasAborted) {
      deps.storage.cancelRun({
        runId: input.runId,
        completedAt: timestamp
      })
    } else {
      deps.storage.failRun({
        runId: input.runId,
        completedAt: timestamp,
        error: message
      })
    }
    if (wasAborted) {
      activeRuns.delete(input.runId)
      if (activeRunByThread.get(input.thread.id) === input.runId) {
        activeRunByThread.delete(input.thread.id)
      }
      activeRunTasks.delete(input.runId)
      deps.emit<RunCancelledEvent>({
        type: 'run.cancelled',
        threadId: input.thread.id,
        runId: input.runId
      })
    } else {
      activeRuns.delete(input.runId)
      if (activeRunByThread.get(input.thread.id) === input.runId) {
        activeRunByThread.delete(input.thread.id)
      }
      activeRunTasks.delete(input.runId)
      deps.emit<RunFailedEvent>({
        type: 'run.failed',
        threadId: input.thread.id,
        runId: input.runId,
        error: message
      })
    }
  }
}
