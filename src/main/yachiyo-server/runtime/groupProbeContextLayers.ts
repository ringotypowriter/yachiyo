import type { ModelMessage } from './types.ts'
import { toModelHistoryMessages, type ContextLayerHistoryMessage } from './contextLayers.ts'

export interface CompileGroupProbeContextLayersInput {
  stableSystemPrompt: string
  dynamicSystemPrompt: string
  rollingSummary?: string
  history: ContextLayerHistoryMessage[]
  currentTurnContent: string
}

function removeEmptyMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter((message) => {
    if (typeof message.content === 'string') {
      return message.content.trim().length > 0
    }

    return message.content.length > 0
  })
}

export function compileGroupProbeContextLayers(
  input: CompileGroupProbeContextLayersInput
): ModelMessage[] {
  const systemPrefix: ModelMessage[] = []
  if (input.stableSystemPrompt.trim()) {
    systemPrefix.push({ role: 'system', content: input.stableSystemPrompt.trim() })
  }
  if (input.dynamicSystemPrompt.trim()) {
    systemPrefix.push({ role: 'system', content: input.dynamicSystemPrompt.trim() })
  }

  const summaryMessages: ModelMessage[] = input.rollingSummary?.trim()
    ? [
        {
          role: 'user',
          content: [
            '<conversation_summary>',
            input.rollingSummary.trim(),
            '</conversation_summary>'
          ].join('\n')
        }
      ]
    : []

  const historyMessages = input.history.flatMap(toModelHistoryMessages)

  const currentTurn: ModelMessage[] = input.currentTurnContent.trim()
    ? [{ role: 'user', content: input.currentTurnContent.trim() }]
    : []

  return removeEmptyMessages([
    ...systemPrefix,
    ...summaryMessages,
    ...historyMessages,
    ...currentTurn
  ])
}
