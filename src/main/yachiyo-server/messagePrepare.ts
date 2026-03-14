import type { ModelMessage as AiSdkModelMessage } from 'ai'

import { SYSTEM_PROMPT } from './prompt.ts'
import type { ModelMessage, ModelStreamRequest } from './types.ts'

interface MessagePrepareInput {
  history: Array<{ role: 'user' | 'assistant'; content: string }>
}

function removeEmptyMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((message) => message.content.trim().length > 0)
}

export function prepareModelMessages(input: MessagePrepareInput): ModelMessage[] {
  return removeEmptyMessages([{ role: 'system', content: SYSTEM_PROMPT }, ...input.history])
}

export function prepareAiSdkMessages(
  messages: ModelStreamRequest['messages']
): AiSdkModelMessage[] {
  return removeEmptyMessages(messages).map((message) => ({
    role: message.role,
    content: message.content
  }))
}
