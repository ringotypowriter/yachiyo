import type {
  MessageRecord,
  MessageTextBlockRecord,
  ProviderSettings,
  ThreadRecord
} from '@yachiyo/shared/protocol'
import type { YachiyoStorage } from '../../../../storage/storage.ts'

export interface AssistantMessageInput {
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

export function buildAssistantMessage(input: AssistantMessageInput): MessageRecord {
  return {
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
}

export function persistThreadAssistantMessage(
  deps: {
    readThread: (threadId: string) => ThreadRecord
    storage: Pick<YachiyoStorage, 'saveThreadMessage'>
  },
  input: AssistantMessageInput & {
    resolveUpdatedThread: (thread: ThreadRecord, message: MessageRecord) => ThreadRecord
  }
): { assistantMessage: MessageRecord; thread: ThreadRecord; updatedThread: ThreadRecord } {
  const assistantMessage = buildAssistantMessage(input)
  const thread = deps.readThread(input.threadId)
  const updatedThread = input.resolveUpdatedThread(thread, assistantMessage)
  deps.storage.saveThreadMessage({
    thread,
    updatedThread,
    message: assistantMessage
  })
  return { assistantMessage, thread, updatedThread }
}

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
  const assistantMessage = buildAssistantMessage(input)
  const currentThread = deps.readThread(input.threadId)

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
