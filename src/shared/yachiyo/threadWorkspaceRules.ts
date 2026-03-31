import type { MessageRecord } from './protocol.ts'

function isThreadLocalMessage(
  message: Pick<MessageRecord, 'createdAt'>,
  threadCreatedAt: string | null | undefined
): boolean {
  return !threadCreatedAt || message.createdAt.localeCompare(threadCreatedAt) >= 0
}

export function isFreshHandoffWorkspaceThread(input: {
  messages: ReadonlyArray<Pick<MessageRecord, 'createdAt' | 'parentMessageId' | 'role'>>
  threadCreatedAt: string | null | undefined
}): boolean {
  const threadLocalMessages = input.messages.filter((message) =>
    isThreadLocalMessage(message, input.threadCreatedAt)
  )

  if (threadLocalMessages.length !== 1) {
    return false
  }

  const [firstMessage] = threadLocalMessages
  return firstMessage?.role === 'assistant' && firstMessage.parentMessageId === undefined
}

export function canChangeThreadWorkspace(input: {
  messages: ReadonlyArray<Pick<MessageRecord, 'createdAt' | 'parentMessageId' | 'role'>>
  threadCreatedAt: string | null | undefined
}): boolean {
  const hasThreadLocalMessages = input.messages.some((message) =>
    isThreadLocalMessage(message, input.threadCreatedAt)
  )

  if (!hasThreadLocalMessages) {
    return true
  }

  return isFreshHandoffWorkspaceThread(input)
}
