import type { MessageRecord, MessageTextBlockRecord } from '@yachiyo/shared/protocol'

interface ResponsePart {
  type: string
  text?: string
  toolCallId?: string
}

interface ResponseMessage {
  role: string
  content: string | ResponsePart[]
}

export type TruncateAssistantMessageResult =
  | { kind: 'truncated'; message: MessageRecord }
  | { kind: 'empty' }
  | { kind: 'not-found' }

function isResponseMessage(value: unknown): value is ResponseMessage {
  if (typeof value !== 'object' || value === null) return false
  const message = value as { role?: unknown; content?: unknown }
  return (
    typeof message.role === 'string' &&
    (typeof message.content === 'string' || Array.isArray(message.content))
  )
}

function collectAssistantText(messages: ResponseMessage[]): string {
  let text = ''
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    if (typeof message.content === 'string') {
      text += message.content
      continue
    }
    for (const part of message.content) {
      if (part.type === 'text' && typeof part.text === 'string') text += part.text
    }
  }
  return text
}

function collectReasoningText(messages: ResponseMessage[]): string {
  let text = ''
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'reasoning' && typeof part.text === 'string') text += part.text
    }
  }
  return text
}

/** Keep whole blocks inside keptText, slice the straddling block, drop the rest. */
function truncateTextBlocks(
  blocks: MessageTextBlockRecord[] | undefined,
  originalContent: string,
  keptText: string
): MessageTextBlockRecord[] | undefined {
  if (!blocks || blocks.length === 0) return undefined
  if (!originalContent.startsWith(keptText)) {
    return [{ ...blocks[0], content: keptText }]
  }
  const kept: MessageTextBlockRecord[] = []
  let consumed = 0
  for (const block of blocks) {
    if (consumed >= keptText.length) break
    const remaining = keptText.length - consumed
    const content =
      block.content.length <= remaining ? block.content : block.content.slice(0, remaining)
    if (content.length > 0) kept.push({ ...block, content })
    consumed += block.content.length
  }
  return kept
}

/**
 * Truncate an assistant message's persisted turn to just before the given tool call:
 * earlier response messages are kept whole, the cut message keeps only the parts before
 * the tool call (dropping sibling tool calls and trailing reasoning), and everything
 * after the cut is discarded. content/textBlocks/reasoning are rebuilt from what remains.
 */
export function truncateAssistantMessageBeforeToolCall(
  message: MessageRecord,
  toolCallId: string
): TruncateAssistantMessageResult {
  const source = message.responseMessages
  if (!Array.isArray(source) || source.length === 0) return { kind: 'not-found' }
  const responseMessages = source.filter(isResponseMessage)

  const cutIndex = responseMessages.findIndex(
    (candidate) =>
      candidate.role === 'assistant' &&
      Array.isArray(candidate.content) &&
      candidate.content.some((part) => part.type === 'tool-call' && part.toolCallId === toolCallId)
  )
  if (cutIndex === -1) return { kind: 'not-found' }

  const cutMessage = responseMessages[cutIndex]
  const cutParts = cutMessage.content as ResponsePart[]
  const partIndex = cutParts.findIndex(
    (part) => part.type === 'tool-call' && part.toolCallId === toolCallId
  )

  const keptParts = cutParts.slice(0, partIndex).filter((part) => part.type !== 'tool-call')
  while (keptParts.length > 0 && keptParts.at(-1)!.type !== 'text') {
    keptParts.pop()
  }

  const kept: ResponseMessage[] = structuredClone(responseMessages.slice(0, cutIndex))
  if (keptParts.length > 0) {
    kept.push({ role: 'assistant', content: structuredClone(keptParts) })
  }

  const content = collectAssistantText(kept)
  if (content === '') return { kind: 'empty' }

  const reasoning = collectReasoningText(kept)
  const textBlocks = truncateTextBlocks(message.textBlocks, message.content, content)

  const truncated: MessageRecord = {
    ...message,
    content,
    responseMessages: kept
  }
  if (textBlocks) {
    truncated.textBlocks = textBlocks
  } else {
    delete truncated.textBlocks
  }
  if (reasoning !== '') {
    truncated.reasoning = reasoning
  } else {
    delete truncated.reasoning
  }
  return { kind: 'truncated', message: truncated }
}
