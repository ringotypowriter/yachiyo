import type { MessageTextBlockRecord, ToolCall } from '@renderer/app/types'

export type ConversationGroupTimelineItem =
  | { kind: 'memory-recall'; key: 'memory-recall' }
  | { kind: 'reply-nav'; key: 'reply-nav' }
  | { kind: 'assistant-text-block'; key: string; textBlockId: string }
  | { kind: 'tool-call'; key: string; toolCallId: string }
  | { kind: 'preparing'; key: 'preparing' }

interface ChronologicalTimelineEntry {
  item: ConversationGroupTimelineItem
  priority: number
  time: string
}

function compareTimelineEntries(
  left: ChronologicalTimelineEntry,
  right: ChronologicalTimelineEntry
): number {
  const timeDifference = left.time.localeCompare(right.time)
  if (timeDifference !== 0) {
    return timeDifference
  }

  return left.priority - right.priority
}

export function buildConversationGroupTimelineItems(input: {
  hasMemoryRecall: boolean
  replyCount: number
  showPreparing: boolean
  activeAssistantTextBlocks: MessageTextBlockRecord[]
  visibleToolCalls: ToolCall[]
}): ConversationGroupTimelineItem[] {
  const items: ConversationGroupTimelineItem[] = []

  if (input.hasMemoryRecall) {
    items.push({ kind: 'memory-recall', key: 'memory-recall' })
  }

  if (input.replyCount > 1) {
    items.push({ kind: 'reply-nav', key: 'reply-nav' })
  }

  const chronologicalEntries: ChronologicalTimelineEntry[] = []

  for (const textBlock of input.activeAssistantTextBlocks) {
    chronologicalEntries.push({
      item: {
        kind: 'assistant-text-block',
        key: textBlock.id,
        textBlockId: textBlock.id
      },
      time: textBlock.createdAt,
      priority: 0
    })
  }

  for (const toolCall of input.visibleToolCalls) {
    chronologicalEntries.push({
      item: {
        kind: 'tool-call',
        key: toolCall.id,
        toolCallId: toolCall.id
      },
      time: toolCall.startedAt,
      priority: 1
    })
  }

  items.push(...chronologicalEntries.sort(compareTimelineEntries).map((entry) => entry.item))

  if (input.showPreparing) {
    items.push({ kind: 'preparing', key: 'preparing' })
  }

  return items
}
