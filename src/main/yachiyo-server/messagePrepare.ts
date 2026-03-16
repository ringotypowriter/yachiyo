import type { ModelMessage as AiSdkModelMessage } from 'ai'

import { SYSTEM_PROMPT } from './prompt.ts'
import type { ModelMessage, ModelStreamRequest } from './types.ts'
import type { MessageImageRecord } from '../../shared/yachiyo/protocol'
import {
  extractBase64DataUrlPayload,
  normalizeMessageImages
} from '../../shared/yachiyo/messageContent.ts'

interface MessagePrepareInput {
  history: Array<{ role: 'user' | 'assistant'; content: string; images?: MessageImageRecord[] }>
}

function removeEmptyMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((message) => {
    if (typeof message.content === 'string') {
      return message.content.trim().length > 0
    }

    return message.content.length > 0
  })
}

function toModelMessage(message: MessagePrepareInput['history'][number]): ModelMessage {
  if (message.role !== 'user') {
    return {
      role: message.role,
      content: message.content
    }
  }

  const images = normalizeMessageImages(message.images)
  if (images.length === 0) {
    return {
      role: 'user',
      content: message.content
    }
  }

  return {
    role: 'user',
    content: [
      ...(message.content.trim().length > 0
        ? [{ type: 'text' as const, text: message.content }]
        : []),
      ...images.map((image) => ({
        type: 'image' as const,
        image: extractBase64DataUrlPayload(image.dataUrl)?.base64 ?? image.dataUrl,
        mediaType: image.mediaType
      }))
    ]
  }
}

export function prepareModelMessages(input: MessagePrepareInput): ModelMessage[] {
  return removeEmptyMessages([
    { role: 'system', content: SYSTEM_PROMPT },
    ...input.history.map(toModelMessage)
  ])
}

export function prepareAiSdkMessages(
  messages: ModelStreamRequest['messages']
): AiSdkModelMessage[] {
  return removeEmptyMessages(messages)
}
