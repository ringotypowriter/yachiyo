import type {
  ChannelGroupRecord,
  MessageRecord,
  ThreadModelOverride,
  ThreadRecord
} from '../../../shared/yachiyo/protocol.ts'
import type { AuxiliaryTextGenerationResult } from '../runtime/auxiliaryGeneration.ts'
import type { ContextLayerHistoryMessage } from '../runtime/contextLayers.ts'
import { repairReplayHistoryMessages } from '../runtime/replayHistoryRepair.ts'
import type { YachiyoStorage } from '../storage/storage.ts'

export interface ResolveGroupProbeThreadOptions {
  logLabel: string
  server: {
    findActiveGroupThread(channelGroupId: string, maxAgeMs: number): ThreadRecord | undefined
    createThread(input: {
      workspacePath?: string
      source?: ThreadRecord['source']
      channelGroupId?: string
      title?: string
    }): Promise<ThreadRecord>
    setThreadModelOverride(input: {
      threadId: string
      modelOverride: ThreadModelOverride | null
    }): Promise<ThreadRecord>
    getThreadTotalTokens(threadId: string): number
  }
  group: ChannelGroupRecord
  groupThreadReuseWindowMs: number
  modelOverride?: ThreadModelOverride
}

export interface ResolveGroupProbeThreadResult {
  thread: ThreadRecord
}

function toWantedModelOverride(
  modelOverride: ThreadModelOverride | undefined
): ThreadModelOverride | null {
  if (!modelOverride?.providerName || !modelOverride?.model) {
    return null
  }
  return modelOverride
}

export async function resolveGroupProbeThread(
  input: ResolveGroupProbeThreadOptions
): Promise<ResolveGroupProbeThreadResult> {
  const { logLabel, server, group, groupThreadReuseWindowMs, modelOverride } = input
  const wantedOverride = toWantedModelOverride(modelOverride)
  const existing = server.findActiveGroupThread(group.id, groupThreadReuseWindowMs)

  if (existing) {
    let thread = existing
    const currentOverride = existing.modelOverride
    const overrideChanged =
      (currentOverride?.providerName ?? '') !== (wantedOverride?.providerName ?? '') ||
      (currentOverride?.model ?? '') !== (wantedOverride?.model ?? '')

    if (overrideChanged) {
      thread = await server.setThreadModelOverride({
        threadId: existing.id,
        modelOverride: wantedOverride
      })
      console.log(
        `[${logLabel}] reconciled model override on group thread ${existing.id}:`,
        wantedOverride ?? 'cleared'
      )
    }

    const totalTokens = server.getThreadTotalTokens(thread.id)
    console.log(`[${logLabel}] existing group thread ${thread.id} — ${totalTokens} tokens`)

    return { thread }
  }

  let thread = await server.createThread({
    workspacePath: group.workspacePath,
    source: group.platform,
    channelGroupId: group.id,
    title: `${group.name} [group probe]`
  })

  if (wantedOverride) {
    thread = await server.setThreadModelOverride({
      threadId: thread.id,
      modelOverride: wantedOverride
    })
  }

  return { thread }
}

function trimHistoryToWatermark(
  messages: MessageRecord[],
  summaryWatermarkMessageId?: string
): MessageRecord[] {
  if (!summaryWatermarkMessageId) {
    return messages
  }
  const watermarkIndex = messages.findIndex((message) => message.id === summaryWatermarkMessageId)
  return watermarkIndex >= 0 ? messages.slice(watermarkIndex + 1) : messages
}

export function loadGroupProbeHistory(
  storage: Pick<YachiyoStorage, 'listThreadMessages' | 'persistResponseMessagesRepairInBackground'>,
  thread: Pick<ThreadRecord, 'id' | 'summaryWatermarkMessageId'>
): ContextLayerHistoryMessage[] {
  return repairReplayHistoryMessages({
    messages: trimHistoryToWatermark(
      storage.listThreadMessages(thread.id),
      thread.summaryWatermarkMessageId
    ),
    persistRepairedResponseMessages: (repair) => {
      storage.persistResponseMessagesRepairInBackground?.(repair)
    }
  }).map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.images ? { images: message.images } : {}),
    ...(message.attachments ? { attachments: message.attachments } : {}),
    ...(message.responseMessages ? { responseMessages: message.responseMessages } : {}),
    ...(message.turnContext ? { turnContext: message.turnContext } : {})
  }))
}

export interface PersistSuccessfulGroupProbeTurnInput {
  storage: Pick<YachiyoStorage, 'getThread' | 'startRun' | 'completeRun'>
  generateId: () => string
  thread: ThreadRecord
  requestContent: string
  result: Extract<AuxiliaryTextGenerationResult, { status: 'success' }>
  requestAt?: string
  assistantAt?: string
}

export function persistSuccessfulGroupProbeTurn(
  input: PersistSuccessfulGroupProbeTurnInput
): ThreadRecord {
  const requestAt = input.requestAt ?? new Date().toISOString()
  const assistantAt = input.assistantAt ?? requestAt
  const liveThread = input.storage.getThread(input.thread.id) ?? input.thread
  const requestMessageId = input.generateId()
  const runId = input.generateId()
  const assistantMessageId = input.generateId()

  const userMessage: MessageRecord = {
    id: requestMessageId,
    threadId: input.thread.id,
    ...(liveThread.headMessageId ? { parentMessageId: liveThread.headMessageId } : {}),
    role: 'user',
    content: input.requestContent,
    hidden: true,
    status: 'completed',
    createdAt: requestAt
  }

  const threadAfterRequest: ThreadRecord = {
    ...liveThread,
    headMessageId: userMessage.id,
    updatedAt: requestAt
  }

  input.storage.startRun({
    runId,
    thread: threadAfterRequest,
    updatedThread: threadAfterRequest,
    requestMessageId: userMessage.id,
    userMessage,
    createdAt: requestAt
  })

  const assistantMessage: MessageRecord = {
    id: assistantMessageId,
    threadId: input.thread.id,
    parentMessageId: userMessage.id,
    role: 'assistant',
    content: input.result.text,
    hidden: true,
    status: 'completed',
    createdAt: assistantAt,
    ...(input.result.usage?.responseMessages
      ? { responseMessages: input.result.usage.responseMessages }
      : {}),
    ...(input.result.settings.model ? { modelId: input.result.settings.model } : {}),
    ...(input.result.settings.providerName
      ? { providerName: input.result.settings.providerName }
      : {})
  }

  const threadAfterAssistant: ThreadRecord = {
    ...threadAfterRequest,
    headMessageId: assistantMessage.id,
    updatedAt: assistantAt
  }

  input.storage.completeRun({
    runId,
    updatedThread: threadAfterAssistant,
    assistantMessage,
    ...(input.result.usage?.promptTokens != null
      ? { promptTokens: input.result.usage.promptTokens }
      : {}),
    ...(input.result.usage?.completionTokens != null
      ? { completionTokens: input.result.usage.completionTokens }
      : {}),
    ...(input.result.usage?.totalPromptTokens != null
      ? { totalPromptTokens: input.result.usage.totalPromptTokens }
      : {}),
    ...(input.result.usage?.totalCompletionTokens != null
      ? { totalCompletionTokens: input.result.usage.totalCompletionTokens }
      : {}),
    ...(input.result.usage?.cacheReadTokens != null
      ? { cacheReadTokens: input.result.usage.cacheReadTokens }
      : {}),
    ...(input.result.usage?.cacheWriteTokens != null
      ? { cacheWriteTokens: input.result.usage.cacheWriteTokens }
      : {}),
    ...(input.result.settings.model ? { modelId: input.result.settings.model } : {}),
    ...(input.result.settings.providerName
      ? { providerName: input.result.settings.providerName }
      : {})
  })

  return threadAfterAssistant
}
