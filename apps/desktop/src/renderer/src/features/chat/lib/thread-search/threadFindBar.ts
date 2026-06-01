import type { Message, ToolCall } from '@renderer/app/types'

export interface FindMatch {
  messageId: string
}

export function buildFindMatches(
  messages: Message[],
  toolCalls: ToolCall[],
  query: string
): FindMatch[] {
  if (query.trim().length < 2) return []

  const lowerQuery = query.toLowerCase()
  const matchedIds: string[] = []
  const seenIds = new Set<string>()

  const sortedMessages = [...messages].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )

  for (const msg of sortedMessages) {
    const text =
      msg.textBlocks && msg.textBlocks.length > 0
        ? msg.textBlocks.map((b) => b.content).join(' ')
        : msg.content

    if (text.toLowerCase().includes(lowerQuery)) {
      if (!seenIds.has(msg.id)) {
        seenIds.add(msg.id)
        matchedIds.push(msg.id)
      }
    }
  }

  const sortedToolCalls = [...toolCalls].sort(
    (a, b) => new Date(a.startedAt ?? 0).getTime() - new Date(b.startedAt ?? 0).getTime()
  )

  for (const tc of sortedToolCalls) {
    const anchor = tc.assistantMessageId ?? tc.requestMessageId
    if (!anchor) continue

    const text = [tc.inputSummary, tc.outputSummary].filter(Boolean).join(' ')
    if (text.toLowerCase().includes(lowerQuery)) {
      if (!seenIds.has(anchor)) {
        seenIds.add(anchor)
        matchedIds.push(anchor)
      }
    }
  }

  return matchedIds.map((id) => ({ messageId: id }))
}
