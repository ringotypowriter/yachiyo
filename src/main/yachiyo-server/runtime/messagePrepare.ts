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

/**
 * Ensure tool-call/tool-result pairs are well-formed before the messages reach
 * the model API:
 *
 * 1. **Patch missing toolCallId on tool-call parts** — Some providers or
 *    recovery paths produce tool-call objects where `toolCallId` is undefined.
 *    The subsequent tool-result references the ID, but the tool-call block
 *    doesn't carry it, causing the API to reject with "tool call id X is not
 *    found". We rebuild the ID from the next tool-result that references it.
 *
 * 2. **Strip orphaned tool-results** — tool-result blocks whose `toolCallId`
 *    does not match any preceding tool-call are removed.
 *
 * 3. **Inject synthetic results** — tool-call blocks with no subsequent
 *    tool-result get a synthetic error result so the API sees a complete pair.
 */
export function balanceHistoryMessages(messages: ModelMessage[]): ModelMessage[] {
  let modified = false

  // --- Phase 1: Patch tool-call parts that are missing their toolCallId ------
  // For each assistant message with tool-call parts that lack a toolCallId,
  // look at the immediately following tool message and assign the ID from the
  // matching tool-result (by position/toolName).
  const patched = messages.map((msg, idx): ModelMessage => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg

    const content = msg.content as ContentPart[]
    const toolCallParts = content.filter((p) => p.type === 'tool-call')
    const hasMissingId = toolCallParts.some((p) => !p.toolCallId)
    if (!hasMissingId) return msg

    // Find the next tool message to harvest IDs from
    const nextTool = messages[idx + 1]
    const toolResults =
      nextTool?.role === 'tool' && Array.isArray(nextTool.content)
        ? (nextTool.content as ContentPart[]).filter(
            (p) => p.type === 'tool-result' || p.type === 'tool-error'
          )
        : []

    // Match missing tool-call IDs by strict position only — never by tool
    // name, because parallel calls of the same tool would cross-match and
    // corrupt the history by pairing the wrong input with the wrong output.
    let resultIdx = 0
    const newContent = content.map((part) => {
      if (part.type !== 'tool-call') return part
      if (part.toolCallId) {
        resultIdx++
        return part
      }
      const positionalMatch = toolResults[resultIdx]
      resultIdx++
      if (positionalMatch?.toolCallId) {
        console.warn(
          `[messagePrepare] tool-call missing toolCallId: toolName=${part.toolName} ` +
            `patched from positional tool-result id=${positionalMatch.toolCallId}`
        )
        modified = true
        return { ...part, toolCallId: positionalMatch.toolCallId }
      }
      // No positional match — generate a synthetic ID so the block isn't malformed
      const syntheticId = `patched_${part.toolName ?? 'unknown'}_${idx}_${resultIdx}`
      console.warn(
        `[messagePrepare] tool-call missing toolCallId with no matching result: ` +
          `toolName=${part.toolName} assigned synthetic id=${syntheticId}`
      )
      modified = true
      return { ...part, toolCallId: syntheticId }
    })

    return { ...msg, content: newContent } as ModelMessage
  })

  // --- Phase 2: Strip orphaned & duplicate tool-results, inject synthetic results
  const declaredToolCallIds = new Set<string>()
  const toolNameById = new Map<string, string>()
  for (const msg of patched) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    for (const part of msg.content as ContentPart[]) {
      if (part.type === 'tool-call' && part.toolCallId) {
        declaredToolCallIds.add(part.toolCallId)
        if (part.toolName) toolNameById.set(part.toolCallId, part.toolName)
      }
    }
  }

  const result: ModelMessage[] = []
  const pendingToolCallIds = new Set<string>()
  // Track toolCallIds that already have a result — strip later duplicates.
  const consumedToolCallIds = new Set<string>()

  for (const msg of patched) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const part of msg.content as ContentPart[]) {
        if (part.type === 'tool-call' && part.toolCallId) {
          pendingToolCallIds.add(part.toolCallId)
        }
      }
      result.push(msg)
      continue
    }

    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      const filtered = (msg.content as ContentPart[]).filter((part) => {
        if (part.type !== 'tool-result' && part.type !== 'tool-error') return true
        if (!part.toolCallId) return true
        // Strip orphaned: no matching tool-call declared anywhere
        if (!declaredToolCallIds.has(part.toolCallId)) {
          modified = true
          return false
        }
        // Strip duplicate: a result for this toolCallId already appeared earlier
        if (consumedToolCallIds.has(part.toolCallId)) {
          modified = true
          return false
        }
        consumedToolCallIds.add(part.toolCallId)
        pendingToolCallIds.delete(part.toolCallId)
        return true
      })
      if (filtered.length > 0) {
        result.push({ ...msg, content: filtered } as ModelMessage)
      } else {
        modified = true
      }
      continue
    }

    if (msg.role === 'user' && pendingToolCallIds.size > 0) {
      modified = true
      const syntheticResults = [...pendingToolCallIds].map((toolCallId) => ({
        type: 'tool-result' as const,
        toolCallId,
        toolName: toolNameById.get(toolCallId) ?? 'unknown',
        output: { type: 'text', value: '[Interrupted before tool result was received]' }
      }))
      result.push({ role: 'tool', content: syntheticResults } as ModelMessage)
      pendingToolCallIds.clear()
    }

    result.push(msg)
  }

  if (pendingToolCallIds.size > 0) {
    modified = true
    const syntheticResults = [...pendingToolCallIds].map((toolCallId) => ({
      type: 'tool-result' as const,
      toolCallId,
      toolName: 'unknown',
      output: { type: 'text', value: '[Interrupted before tool result was received]' }
    }))
    result.push({ role: 'tool', content: syntheticResults } as ModelMessage)
  }

  if (modified) {
    console.warn('[messagePrepare] balanceHistoryMessages repaired tool-call/tool-result pairs')
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
