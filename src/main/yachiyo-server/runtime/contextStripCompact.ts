import type { ModelMessage } from './types.ts'
import { estimateTextTokens } from '../../../shared/yachiyo/estimateTokens.ts'

export const STRIP_COMPACT_TOKEN_THRESHOLD = 200_000
const SUMMARY_PREVIEW_CHARS = 200
const MESSAGE_OVERHEAD_TOKENS = 4

interface RunSpan {
  startIndex: number
  endIndex: number
}

function extractTextContent(value: unknown, seen = new WeakSet<object>()): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => extractTextContent(item, seen))
      .filter((text) => text.length > 0)
      .join(' ')
  }
  if (!value || typeof value !== 'object') return ''

  if (seen.has(value)) return ''
  seen.add(value)

  const record = value as Record<string, unknown>
  if (record.type === 'image' || record.type === 'image-data') {
    return ''
  }

  const fragments: string[] = []

  if (typeof record.text === 'string') {
    fragments.push(record.text)
  }
  if (typeof record.value === 'string') {
    fragments.push(record.value)
  }

  for (const nestedKey of ['value', 'output', 'input', 'content']) {
    const nested = record[nestedKey]
    if (Array.isArray(nested) || (nested && typeof nested === 'object')) {
      const nestedText = extractTextContent(nested, seen)
      if (nestedText.length > 0) {
        fragments.push(nestedText)
      }
    }
  }

  for (const [key, nested] of Object.entries(record)) {
    if (
      key === 'text' ||
      key === 'value' ||
      key === 'output' ||
      key === 'input' ||
      key === 'content' ||
      key === 'image' ||
      key === 'data' ||
      key === 'dataUrl'
    ) {
      continue
    }
    if (typeof nested === 'string' || Array.isArray(nested) || typeof nested === 'object') {
      const nestedText = extractTextContent(nested, seen)
      if (nestedText.length > 0) {
        fragments.push(nestedText)
      }
    }
  }

  return fragments.join(' ')
}

function extractMessageText(msg: ModelMessage): string {
  return extractTextContent(msg.content)
}

function estimateModelMessageTokens(msg: ModelMessage): number {
  return estimateTextTokens(extractMessageText(msg)) + MESSAGE_OVERHEAD_TOKENS
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
  return messages.reduce((sum, msg) => sum + estimateModelMessageTokens(msg), 0)
}

function estimateTokenSavings(before: ModelMessage, after: ModelMessage): number {
  return Math.max(0, estimateModelMessageTokens(before) - estimateModelMessageTokens(after))
}

function buildStrippedSummary(part: {
  toolName?: string
  result?: unknown
  output: unknown
}): string {
  const text = extractTextContent(part.output)
  const lineCount = text ? text.split('\n').length : 0
  const preview = text.slice(0, SUMMARY_PREVIEW_CHARS)
  const toolLabel = part.toolName ?? 'unknown'
  const resultLabel = typeof part.result === 'string' ? part.result : 'done'
  const truncated = text.length > SUMMARY_PREVIEW_CHARS ? '…' : ''
  return `[Stripped: ${toolLabel} → ${resultLabel}, ${lineCount} lines]\n${preview}${truncated}`
}

function stripToolResultsInMessage(msg: ModelMessage): ModelMessage {
  if (msg.role !== 'tool') return msg
  if (!Array.isArray(msg.content)) return msg

  const strippedContent = msg.content.map((part) => {
    if (part.type !== 'tool-result') return part
    const summary = buildStrippedSummary(
      part as { toolName?: string; result?: unknown; output: unknown }
    )
    return {
      ...part,
      output: { type: 'text', value: summary } as typeof part.output
    }
  })
  return { ...msg, content: strippedContent }
}

/**
 * Strip old tool results from messages to reduce context size.
 *
 * Estimates token count from message text content using the same CJK-aware
 * heuristic shared with the renderer. This avoids a feedback loop where
 * a previous stripped run reports low promptTokens, causing the next turn
 * to skip compaction and re-send the full unstripped history.
 *
 * Strips from the newest-eligible run spans first (preserving the oldest
 * prefix for prompt cache stability), re-estimating after each span,
 * until under 200K or all spans except the last are exhausted.
 *
 * Returns the original array unchanged if estimated tokens <= threshold.
 */
export function applyStripCompact(messages: ModelMessage[]): ModelMessage[] {
  let estimatedTokens = estimateTokenCount(messages)
  if (estimatedTokens <= STRIP_COMPACT_TOKEN_THRESHOLD) return messages

  const result = [...messages]
  const spans = identifyRunSpans(result)

  // Never strip the last run — its tool results are actively relevant.
  // Strip from newest-eligible first so the oldest prefix stays stable
  // for prompt caching (providers cache by prefix match).
  const strippableSpans = spans.slice(0, -1).toReversed()
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
