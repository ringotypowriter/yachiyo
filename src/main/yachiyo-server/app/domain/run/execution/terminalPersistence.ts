import type {
  MessageRecord,
  MessageTextBlockRecord,
  ProviderSettings,
  ThreadRecord
} from '../../../../../../shared/yachiyo/protocol.ts'
import type { YachiyoStorage } from '../../../../storage/storage.ts'

export function persistTerminalAssistantMessage(
  deps: {
    readThread: (threadId: string) => ThreadRecord
    storage: Pick<YachiyoStorage, 'completeRun'>
  },
  input: {
    runId: string
    threadId: string
    messageId: string
    requestMessageId: string
    timestamp: string
    settings: ProviderSettings
    status: MessageRecord['status']
    content: string
    textBlocks: MessageTextBlockRecord[]
    reasoning?: string
    responseMessages?: unknown[]
  }
): MessageRecord {
  const currentThread = deps.readThread(input.threadId)
  const assistantMessage: MessageRecord = {
    id: input.messageId,
    threadId: input.threadId,
    parentMessageId: input.requestMessageId,
    role: 'assistant',
    content: input.content,
    ...(input.textBlocks.length > 0 ? { textBlocks: input.textBlocks } : {}),
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    ...(input.responseMessages?.length ? { responseMessages: input.responseMessages } : {}),
    status: input.status,
    createdAt: input.timestamp,
    modelId: input.settings.model,
    providerName: input.settings.providerName
  }

  deps.storage.completeRun({
    runId: input.runId,
    updatedThread: {
      ...currentThread,
      updatedAt: input.timestamp
    },
    assistantMessage,
    modelId: input.settings.model,
    providerName: input.settings.providerName
  })

  return assistantMessage
}
