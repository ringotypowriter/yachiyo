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

type ContentPart = { type?: string; toolCallId?: string; toolName?: string; [key: string]: unknown }

function toolNamesMatch(left?: string, right?: string): boolean {
  return !left || !right || left === right
}

function repairAdjacentToolCallIds(input: {
  assistantContent: ContentPart[]
  toolContent: ContentPart[]
}): { assistantContent: ContentPart[]; toolContent: ContentPart[]; repaired: boolean } {
  const toolCalls = input.assistantContent.flatMap((part, index) =>
    part.type === 'tool-call' ? [{ index, part }] : []
  )
  const toolResults = input.toolContent.flatMap((part, index) =>
    part.type === 'tool-result' || part.type === 'tool-error' ? [{ index, part }] : []
  )

  const matchedToolCallIndexes = new Set<number>()
  const matchedToolResultIndexes = new Set<number>()

  for (const toolCall of toolCalls) {
    if (!toolCall.part.toolCallId) {
      continue
    }

    const matchingResult = toolResults.find(
      (toolResult) =>
        !matchedToolResultIndexes.has(toolResult.index) &&
        toolResult.part.toolCallId === toolCall.part.toolCallId
    )

    if (!matchingResult) {
      continue
    }

    matchedToolCallIndexes.add(toolCall.index)
    matchedToolResultIndexes.add(matchingResult.index)
  }

  const unmatchedToolCalls = toolCalls.filter(
    (toolCall) => !matchedToolCallIndexes.has(toolCall.index)
  )
  const unmatchedToolResults = toolResults.filter(
    (toolResult) => !matchedToolResultIndexes.has(toolResult.index)
  )

  let repairedAssistantContent = input.assistantContent
  let repairedToolContent = input.toolContent
  let repaired = false
  const repairablePairCount = Math.min(unmatchedToolCalls.length, unmatchedToolResults.length)

  for (let pairIndex = 0; pairIndex < repairablePairCount; pairIndex++) {
    const toolCall = unmatchedToolCalls[pairIndex]
    const toolResult = unmatchedToolResults[pairIndex]
    const toolCallId = toolCall.part.toolCallId
    const toolResultId = toolResult.part.toolCallId

    if (!toolNamesMatch(toolCall.part.toolName, toolResult.part.toolName)) {
      continue
    }

    if (toolCallId && toolResultId) {
      continue
    }

    if (!toolCallId && !toolResultId) {
      continue
    }

    const repairedToolCallId = toolCallId ?? toolResultId
    if (!repairedToolCallId) {
      continue
    }

    if (!toolCallId) {
      if (repairedAssistantContent === input.assistantContent) {
        repairedAssistantContent = input.assistantContent.slice()
      }
      repairedAssistantContent[toolCall.index] = {
        ...toolCall.part,
        toolCallId: repairedToolCallId
      }
      repaired = true
      continue
    }

    if (repairedToolContent === input.toolContent) {
      repairedToolContent = input.toolContent.slice()
    }
    repairedToolContent[toolResult.index] = {
      ...toolResult.part,
      toolCallId: repairedToolCallId
    }
    repaired = true
  }

  return {
    assistantContent: repairedAssistantContent,
    toolContent: repairedToolContent,
    repaired
  }
}

/**
 * Ensure tool-call/tool-result pairs are well-formed before the messages reach
 * the model API.
 *
 * Strategy: if an otherwise adjacent tool-call / tool-result pair has lost a
 * `toolCallId` on only one side, repair it from the matching neighbour before
 * filtering. Truly malformed pairs (ID mismatch, both IDs missing, or dangling
 * tool-call with no result) are still dropped to prevent upstream errors like
 * "tool_call_id is not found".
 */
export function balanceHistoryMessages(messages: ModelMessage[]): ModelMessage[] {
  let modified = false
  const result: ModelMessage[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    // Drop orphaned tool messages that aren't part of a recognised pair.
    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      modified = true
      continue
    }

    // Pass through non-assistant messages (and assistant messages without
    // array content) untouched.
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) {
      result.push(msg)
      continue
    }

    const assistantContent = msg.content as ContentPart[]
    const assistantToolCallParts = assistantContent.filter((p) => p.type === 'tool-call')
    if (assistantToolCallParts.length === 0) {
      result.push(msg)
      continue
    }

    const nextMsg = i + 1 < messages.length ? messages[i + 1] : undefined
    const hasToolMessage = nextMsg?.role === 'tool' && Array.isArray(nextMsg.content)

    // Dangling tool-calls with no following tool message: drop the calls.
    if (!hasToolMessage) {
      const withoutToolCalls = assistantContent.filter((p) => p.type !== 'tool-call')
      if (withoutToolCalls.length === 0) {
        modified = true
        continue
      }
      modified = true
      result.push({ ...msg, content: withoutToolCalls } as ModelMessage)
      continue
    }

    // We have an assistant + tool pair. Reconcile IDs bidirectionally:
    // an ID is valid only when it appears in BOTH a tool-call and a tool-result.
    const repairedPair = repairAdjacentToolCallIds({
      assistantContent,
      toolContent: nextMsg.content as ContentPart[]
    })
    const balancedAssistantContent = repairedPair.assistantContent
    const balancedToolContent = repairedPair.toolContent
    const toolCallParts = balancedAssistantContent.filter((p) => p.type === 'tool-call')
    const toolResultParts = balancedToolContent.filter(
      (p) => p.type === 'tool-result' || p.type === 'tool-error'
    )

    const callIds = new Set<string>()
    for (const p of toolCallParts) {
      if (p.toolCallId) callIds.add(p.toolCallId)
    }
    const resultIds = new Set<string>()
    for (const p of toolResultParts) {
      if (p.toolCallId) resultIds.add(p.toolCallId)
    }

    const validIds = new Set<string>()
    for (const id of callIds) {
      if (resultIds.has(id)) validIds.add(id)
    }

    // Filter assistant: drop tool-calls with missing or mismatched IDs.
    const filteredAssistant = balancedAssistantContent.filter((part) => {
      if (part.type !== 'tool-call') return true
      return part.toolCallId && validIds.has(part.toolCallId)
    })

    // Filter tool message: drop results with missing or mismatched IDs,
    // and drop duplicate results for the same ID (keep first).
    const seenIds = new Set<string>()
    const filteredTool = balancedToolContent.filter((part) => {
      if (part.type !== 'tool-result' && part.type !== 'tool-error') return true
      const toolCallId = part.toolCallId
      if (!toolCallId) return false
      const keep = validIds.has(toolCallId) && !seenIds.has(toolCallId)
      if (keep) seenIds.add(toolCallId)
      return keep
    })

    const assistantChanged =
      balancedAssistantContent !== assistantContent ||
      filteredAssistant.length !== balancedAssistantContent.length
    const toolChanged =
      balancedToolContent !== nextMsg.content || filteredTool.length !== balancedToolContent.length

    // If the assistant message is empty after filtering, drop the whole pair.
    if (filteredAssistant.length === 0) {
      modified = true
      i++ // skip the paired tool message
      continue
    }

    // If the tool message is empty after filtering, the remaining tool-calls
    // are dangling — drop them as well.
    if (filteredTool.length === 0) {
      modified = true
      const withoutToolCalls = filteredAssistant.filter((p) => p.type !== 'tool-call')
      if (withoutToolCalls.length === 0) {
        i++ // skip the paired tool message
        continue
      }
      result.push({ ...msg, content: withoutToolCalls } as ModelMessage)
      i++ // skip the paired tool message
      continue
    }

    if (assistantChanged || toolChanged) {
      modified = true
    }

    result.push(assistantChanged ? ({ ...msg, content: filteredAssistant } as ModelMessage) : msg)
    result.push(toolChanged ? ({ ...nextMsg, content: filteredTool } as ModelMessage) : nextMsg)
    i++ // advance past the tool message
  }

  if (modified) {
    console.warn(
      '[messagePrepare] balanceHistoryMessages repaired or dropped malformed tool-call pairs'
    )
  }

  return modified ? result : messages
}

export function prepareModelMessages(input: MessagePrepareInput): ModelMessage[] {
  return compileContextLayers(input)
}

export function prepareAiSdkMessages(
  messages: ModelStreamRequest['messages']
): AiSdkModelMessage[] {
  return balanceHistoryMessages(removeEmptyMessages(messages))
}
