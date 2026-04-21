import type { MessageRecord } from '../../../shared/yachiyo/protocol.ts'

import type { PersistResponseMessagesRepairInput } from '../storage/storage.ts'
import { normalizeStoredResponseMessages } from './messagePrepare.ts'

export type ReplayHistoryMessage = Pick<
  MessageRecord,
  'id' | 'role' | 'content' | 'images' | 'attachments' | 'responseMessages' | 'turnContext'
>

export interface RepairReplayHistoryMessagesInput {
  messages: ReplayHistoryMessage[]
  persistRepairedResponseMessages?: (input: PersistResponseMessagesRepairInput) => void
}

export function repairReplayHistoryMessages(
  input: RepairReplayHistoryMessagesInput
): ReplayHistoryMessage[] {
  let modified = false

  const repairedMessages = input.messages.map((message) => {
    if (!message.responseMessages?.length) {
      return message
    }

    const normalized = normalizeStoredResponseMessages(message.responseMessages)
    if (!normalized.modified) {
      return message
    }

    modified = true
    input.persistRepairedResponseMessages?.({
      messageId: message.id,
      responseMessages: normalized.responseMessages
    })

    return {
      ...message,
      responseMessages: normalized.responseMessages
    }
  })

  return modified ? repairedMessages : input.messages
}
