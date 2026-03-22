import type { ModelMessage as AiSdkModelMessage } from 'ai'

import { compileContextLayers, type CompileContextLayersInput } from './contextLayers.ts'
import type { ModelMessage, ModelStreamRequest } from './types.ts'
type MessagePrepareInput = CompileContextLayersInput

function removeEmptyMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((message) => {
    if (typeof message.content === 'string') {
      return message.content.trim().length > 0
    }

    return message.content.length > 0
  })
}

export function prepareModelMessages(input: MessagePrepareInput): ModelMessage[] {
  return compileContextLayers(input)
}

export function prepareAiSdkMessages(
  messages: ModelStreamRequest['messages']
): AiSdkModelMessage[] {
  return removeEmptyMessages(messages)
}
