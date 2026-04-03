import type { MessageStatus, MessageTextBlockRecord, ToolCall } from '@renderer/app/types'

export type ToolCallSemanticGroup =
  | 'search-sources'
  | 'read-sources'
  | 'search-files'
  | 'read-files'
  | 'edit-files'
  | 'write-files'
  | 'run-commands'

const TOOL_CALL_GROUP_LABELS: Record<ToolCallSemanticGroup, { singular: string; plural: string }> =
  {
    'search-sources': { singular: 'Searching 1 source', plural: 'Searching %n sources' },
    'read-sources': { singular: 'Reading 1 source', plural: 'Reading %n sources' },
    'search-files': { singular: 'Searching 1 file', plural: 'Searching %n files' },
    'read-files': { singular: 'Reading 1 file', plural: 'Reading %n files' },
    'edit-files': { singular: 'Editing 1 file', plural: 'Editing %n files' },
    'write-files': { singular: 'Writing 1 file', plural: 'Writing %n files' },
    'run-commands': { singular: 'Running 1 command', plural: 'Running %n commands' }
  }

function getToolCallSemanticGroup(toolName: string): ToolCallSemanticGroup | null {
  switch (toolName) {
    case 'webSearch':
      return 'search-sources'
    case 'webRead':
      return 'read-sources'
    case 'grep':
    case 'glob':
      return 'search-files'
    case 'read':
      return 'read-files'
    case 'edit':
      return 'edit-files'
    case 'write':
      return 'write-files'
    case 'bash':
      return 'run-commands'
    default:
      return null
  }
}

export function getToolCallGroupLabel(group: ToolCallSemanticGroup, count: number): string {
  const labels = TOOL_CALL_GROUP_LABELS[group]
  return count === 1 ? labels.singular : labels.plural.replace('%n', String(count))
}

export type ConversationGroupTimelineItem =
  | { kind: 'memory-recall'; key: 'memory-recall' }
  | { kind: 'assistant-text-block'; key: string; textBlockId: string }
  | { kind: 'tool-call'; key: string; toolCallId: string }
  | {
      kind: 'tool-call-group'
      key: string
      group: ToolCallSemanticGroup
      toolCallIds: string[]
    }
  | { kind: 'generating'; key: 'generating' }
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
  showGenerating: boolean
  activeBranchStatus?: MessageStatus
  activeAssistantTextBlocks: MessageTextBlockRecord[]
  visibleToolCalls: ToolCall[]
}): ConversationGroupTimelineItem[] {
  const items: ConversationGroupTimelineItem[] = []

  if (input.hasMemoryRecall) {
    items.push({ kind: 'memory-recall', key: 'memory-recall' })
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

  const sortedItems = chronologicalEntries.sort(compareTimelineEntries).map((entry) => entry.item)
  const textBlockById = new Map(input.activeAssistantTextBlocks.map((tb) => [tb.id, tb]))
  items.push(...mergeConsecutiveToolCalls(sortedItems, input.visibleToolCalls, textBlockById))

  if (input.showGenerating) {
    items.push({ kind: 'generating', key: 'generating' })
  }

  if (input.showPreparing) {
    items.push({ kind: 'preparing', key: 'preparing' })
  }

  return items
}

const MIN_GROUP_SIZE = 3
const MAX_GAP = 5
const PARALLEL_WINDOW_MS = 2000

/**
 * Single-pass merge: consecutive same-group tool calls are grouped (gap-based).
 * Non-empty text blocks break the scan UNLESS the next same-group tool call
 * started within PARALLEL_WINDOW_MS of the last collected call (parallel batch).
 * Empty text blocks are skipped entirely.
 */
function mergeConsecutiveToolCalls(
  items: ConversationGroupTimelineItem[],
  toolCalls: ToolCall[],
  textBlockById: Map<string, MessageTextBlockRecord>
): ConversationGroupTimelineItem[] {
  const toolCallById = new Map(toolCalls.map((tc) => [tc.id, tc]))
  const result: ConversationGroupTimelineItem[] = []
  let i = 0

  while (i < items.length) {
    const item = items[i]!

    if (item.kind !== 'tool-call') {
      if (item.kind === 'assistant-text-block') {
        const tb = textBlockById.get(item.textBlockId)
        if (tb && !tb.content.trim()) {
          i++
          continue
        }
      }
      result.push(item)
      i++
      continue
    }

    const tc = toolCallById.get(item.toolCallId)
    const group = tc ? getToolCallSemanticGroup(tc.toolName) : null

    if (!group) {
      result.push(item)
      i++
      continue
    }

    const collected: { index: number; toolCallId: string }[] = [
      { index: i, toolCallId: item.toolCallId }
    ]
    let j = i + 1
    let gap = 0

    while (j < items.length && gap <= MAX_GAP) {
      const next = items[j]!

      if (next.kind === 'tool-call') {
        const nextTc = toolCallById.get(next.toolCallId)
        const nextGroup = nextTc ? getToolCallSemanticGroup(nextTc.toolName) : null

        if (nextGroup === group) {
          collected.push({ index: j, toolCallId: next.toolCallId })
          gap = 0
        } else {
          gap++
        }
      } else if (next.kind === 'assistant-text-block') {
        const tb = textBlockById.get(next.textBlockId)
        if (!tb || tb.content.trim()) {
          // Non-empty text block — only skip if a nearby same-group tool call
          // started within PARALLEL_WINDOW_MS of the last collected call
          const lastCollectedTc = toolCallById.get(collected[collected.length - 1]!.toolCallId)!
          const lastStarted = new Date(lastCollectedTc.startedAt).getTime()
          let hasParallelPeer = false
          for (let p = j + 1; p < items.length && p <= j + MAX_GAP + 1; p++) {
            const peek = items[p]!
            if (peek.kind === 'tool-call') {
              const peekTc = toolCallById.get(peek.toolCallId)
              if (
                peekTc &&
                getToolCallSemanticGroup(peekTc.toolName) === group &&
                Math.abs(new Date(peekTc.startedAt).getTime() - lastStarted) <= PARALLEL_WINDOW_MS
              ) {
                hasParallelPeer = true
                break
              }
              // Different-group tool call — keep peeking past it
              continue
            }
            if (peek.kind !== 'assistant-text-block') break
          }
          if (!hasParallelPeer) break
          gap++
        }
        // empty text block — skip, no gap
      } else {
        break
      }

      if (gap > MAX_GAP) break
      j++
    }

    if (collected.length >= MIN_GROUP_SIZE) {
      const groupedSet = new Set(collected.map((c) => c.index))
      const lastGroupedIndex = collected[collected.length - 1]!.index

      result.push({
        kind: 'tool-call-group',
        key: `tool-group:${collected[0]!.toolCallId}`,
        group,
        toolCallIds: collected.map((c) => c.toolCallId)
      })
      for (let k = i; k <= lastGroupedIndex; k++) {
        if (!groupedSet.has(k)) result.push(items[k]!)
      }
      i = lastGroupedIndex + 1
    } else {
      result.push(item)
      i++
    }
  }

  return result
}
