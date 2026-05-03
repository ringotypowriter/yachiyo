import type { MessageRecord, ThreadRecord } from '../../../../../../shared/yachiyo/protocol.ts'
import { collectMessagePath } from '../../../../../../shared/yachiyo/threadTree.ts'

export function withParentMessageId(
  message: MessageRecord,
  parentMessageId?: string
): MessageRecord {
  const rest = { ...message }
  delete rest.parentMessageId

  return {
    ...rest,
    ...(parentMessageId ? { parentMessageId } : {})
  }
}

export function resolveEffectiveThreadMessages(
  thread: ThreadRecord,
  messages: MessageRecord[]
): MessageRecord[] {
  if (messages.length === 0) {
    return []
  }

  const headMessageId =
    thread.headMessageId && messages.some((message) => message.id === thread.headMessageId)
      ? thread.headMessageId
      : [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1)
          ?.id

  if (!headMessageId) {
    return [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  }

  return collectMessagePath(messages, headMessageId)
}
