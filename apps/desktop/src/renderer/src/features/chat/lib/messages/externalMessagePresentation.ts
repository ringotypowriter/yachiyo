import type { Message } from '../../../../app/types.ts'
import { normalizeRunModelLabel } from '../run-memory/runMemoryPresentation.ts'

export interface ExternalAssistantPresentation {
  content: string
  modelLabel: string | null
  standaloneModelLabel: string | null
}

export function buildExternalAssistantPresentation(
  message: Pick<Message, 'content' | 'modelId' | 'visibleReply'>,
  toolCallCount: number
): ExternalAssistantPresentation {
  const content = message.visibleReply ?? message.content
  const modelLabel = normalizeRunModelLabel(message.modelId)

  return {
    content,
    modelLabel,
    standaloneModelLabel: toolCallCount === 0 && content.trim() ? modelLabel : null
  }
}
