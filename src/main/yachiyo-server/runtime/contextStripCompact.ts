import type { ModelMessage } from './types.ts'

export const STRIP_COMPACT_TOKEN_THRESHOLD = 200_000
const CHARS_PER_TOKEN_ESTIMATE = 4
const STRIPPED_PLACEHOLDER = '[Tool result stripped to reduce context size]'

interface RunSpan {
  startIndex: number
  endIndex: number
}

/**
 * Identify contiguous blocks of assistant+tool messages (one "run") between
 * user/system messages in the flattened ModelMessage array.
 */
export function identifyRunSpans(messages: ModelMessage[]): RunSpan[] {
  const spans: RunSpan[] = []
  let i = 0
  while (i < messages.length) {
    if (messages[i].role === 'system' || messages[i].role === 'user') {
      i++
      continue
    }
    const startIndex = i
    while (i < messages.length && messages[i].role !== 'user' && messages[i].role !== 'system') {
      i++
    }
    spans.push({ startIndex, endIndex: i - 1 })
  }
  return spans
}

export function estimateTokenCount(messages: ModelMessage[]): number {
  return JSON.stringify(messages).length / CHARS_PER_TOKEN_ESTIMATE
}

function estimateTokenSavings(before: ModelMessage, after: ModelMessage): number {
  const charsBefore = JSON.stringify(before).length
  const charsAfter = JSON.stringify(after).length
  return Math.max(0, (charsBefore - charsAfter) / CHARS_PER_TOKEN_ESTIMATE)
}

function stripToolResultsInMessage(msg: ModelMessage): ModelMessage {
  if (msg.role !== 'tool') return msg
  if (!Array.isArray(msg.content)) return msg

  const strippedContent = msg.content.map((part) => {
    if (part.type !== 'tool-result') return part
    return {
      ...part,
      output: { type: 'text', value: STRIPPED_PLACEHOLDER } as typeof part.output
    }
  })
  return { ...msg, content: strippedContent }
}

/**
 * Strip old tool results from messages to reduce context size.
 *
 * Estimates token count directly from the compiled messages array (via
 * JSON.stringify character count / 4). This avoids a feedback loop where
 * a previous stripped run reports low promptTokens, causing the next turn
 * to skip compaction and re-send the full unstripped history.
 *
 * Strips the oldest run spans first, re-estimating after each span,
 * until under 200K or all spans except the last are exhausted.
 *
 * Returns the original array unchanged if estimated tokens <= threshold.
 */
export function applyStripCompact(messages: ModelMessage[]): ModelMessage[] {
  let estimatedTokens = estimateTokenCount(messages)
  if (estimatedTokens <= STRIP_COMPACT_TOKEN_THRESHOLD) return messages

  const result = [...messages]
  const spans = identifyRunSpans(result)

  // Never strip the last run — its tool results are actively relevant
  const strippableSpans = spans.slice(0, -1)
  if (strippableSpans.length === 0) return messages

  for (const span of strippableSpans) {
    for (let i = span.startIndex; i <= span.endIndex; i++) {
      if (result[i].role !== 'tool') continue
      const original = result[i]
      const stripped = stripToolResultsInMessage(original)
      estimatedTokens -= estimateTokenSavings(original, stripped)
      result[i] = stripped
    }
    if (estimatedTokens <= STRIP_COMPACT_TOKEN_THRESHOLD) break
  }

  return result
}
