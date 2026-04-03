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

/**
 * Phase 1: Pre-identify parallel batches — tool calls sharing the same
 * assistantMessageId and semantic group are always grouped together,
 * regardless of interleaved items in the timeline.
 *
 * Phase 2: Linear scan merges consecutive/nearby same-group tool calls
 * (gap-based), and non-empty text blocks break the scan UNLESS the
 * tool call is already claimed by a parallel batch.
 */
function mergeConsecutiveToolCalls(
  items: ConversationGroupTimelineItem[],
  toolCalls: ToolCall[],
  textBlockById: Map<string, MessageTextBlockRecord>
): ConversationGroupTimelineItem[] {
  const toolCallById = new Map(toolCalls.map((tc) => [tc.id, tc]))

  // Phase 1: Build parallel batch sets keyed by assistantMessageId + semantic group.
  // Only batches with >= MIN_GROUP_SIZE members qualify.
  const batchKey = (msgId: string, grp: ToolCallSemanticGroup): string => `${msgId}::${grp}`
  const batchMembers = new Map<string, string[]>() // key → toolCallIds
  for (const tc of toolCalls) {
    const grp = getToolCallSemanticGroup(tc.toolName)
    if (!grp || !tc.assistantMessageId) continue
    const key = batchKey(tc.assistantMessageId, grp)
    let members = batchMembers.get(key)
    if (!members) {
      members = []
      batchMembers.set(key, members)
    }
    members.push(tc.id)
  }

  // Map each tool call id to its batch group (if the batch qualifies)
  const toolCallBatch = new Map<string, { group: ToolCallSemanticGroup; ids: string[] }>()
  for (const [, members] of batchMembers) {
    if (members.length < MIN_GROUP_SIZE) continue
    const firstTc = toolCallById.get(members[0]!)!
    const grp = getToolCallSemanticGroup(firstTc.toolName)!
    for (const id of members) {
      toolCallBatch.set(id, { group: grp, ids: members })
    }
  }

  // Phase 2: Walk the timeline, emitting groups for batched tool calls
  // and passing through everything else.
  const result: ConversationGroupTimelineItem[] = []
  const emitted = new Set<string>() // tool call ids already emitted via a group

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!

    if (item.kind !== 'tool-call') {
      // Skip empty text blocks (they render as blank space)
      if (item.kind === 'assistant-text-block') {
        const tb = textBlockById.get(item.textBlockId)
        if (tb && !tb.content.trim()) continue
      }
      result.push(item)
      continue
    }

    // Already emitted as part of a batch group
    if (emitted.has(item.toolCallId)) continue

    const batch = toolCallBatch.get(item.toolCallId)
    if (batch) {
      // Emit the entire batch as a group at the position of its first timeline member
      result.push({
        kind: 'tool-call-group',
        key: `tool-group:${batch.ids[0]}`,
        group: batch.group,
        toolCallIds: batch.ids
      })
      for (const id of batch.ids) emitted.add(id)
      continue
    }

    // Not part of a batch — try consecutive grouping with gap tolerance
    const tc = toolCallById.get(item.toolCallId)
    const group = tc ? getToolCallSemanticGroup(tc.toolName) : null

    if (!group) {
      result.push(item)
      continue
    }

    const collected: { index: number; toolCallId: string }[] = [
      { index: i, toolCallId: item.toolCallId }
    ]
    let j = i + 1
    let gap = 0
    const maxGap = 5

    while (j < items.length && gap <= maxGap) {
      const next = items[j]!

      if (next.kind === 'tool-call') {
        if (emitted.has(next.toolCallId)) {
          j++
          continue
        }
        const nextTc = toolCallById.get(next.toolCallId)
        const nextGroup = nextTc ? getToolCallSemanticGroup(nextTc.toolName) : null

        if (nextGroup === group && !toolCallBatch.has(next.toolCallId)) {
          collected.push({ index: j, toolCallId: next.toolCallId })
          gap = 0
        } else {
          gap++
        }
      } else if (next.kind === 'assistant-text-block') {
        const tb = textBlockById.get(next.textBlockId)
        if (!tb || tb.content.trim()) break // non-empty text breaks consecutive scan
        // empty text block — skip, no gap
      } else {
        break
      }

      if (gap > maxGap) break
      j++
    }

    if (collected.length >= MIN_GROUP_SIZE) {
      const groupedSet = new Set(collected.map((c) => c.index))
      const lastGroupedIndex = collected[collected.length - 1]!.index

      for (let k = i; k <= lastGroupedIndex; k++) {
        if (!groupedSet.has(k)) {
          result.push(items[k]!)
        }
      }
      result.push({
        kind: 'tool-call-group',
        key: `tool-group:${collected[0]!.toolCallId}`,
        group,
        toolCallIds: collected.map((c) => c.toolCallId)
      })
      i = lastGroupedIndex // for loop will i++
    } else {
      result.push(item)
    }
  }

  return result
}
