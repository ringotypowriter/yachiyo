import type { MessageTextBlockRecord, ToolCall } from '@renderer/app/types'
import { resolveBashSemanticGroup } from '../../../../../shared/yachiyo/bashSemanticAnalyzer.ts'

export type ToolCallSemanticGroup =
  | 'search-sources'
  | 'read-sources'
  | 'search-files'
  | 'read-files'
  | 'edit-files'
  | 'write-files'
  | 'run-commands'
  | 'inspect-workspace'
  | 'search-memory'

const TOOL_CALL_GROUP_LABELS: Record<
  ToolCallSemanticGroup,
  { singular: string; plural: string; doneSingular: string; donePlural: string }
> = {
  'search-sources': {
    singular: 'Searching 1 source',
    plural: 'Searching %n sources',
    doneSingular: 'Searched 1 source',
    donePlural: 'Searched %n sources'
  },
  'read-sources': {
    singular: 'Reading 1 source',
    plural: 'Reading %n sources',
    doneSingular: 'Read 1 source',
    donePlural: 'Read %n sources'
  },
  'search-files': {
    singular: 'Searching 1 pattern',
    plural: 'Searching %n patterns',
    doneSingular: 'Searched 1 pattern',
    donePlural: 'Searched %n patterns'
  },
  'read-files': {
    singular: 'Reading 1 file',
    plural: 'Reading %n files',
    doneSingular: 'Read 1 file',
    donePlural: 'Read %n files'
  },
  'edit-files': {
    singular: 'Editing 1 file',
    plural: 'Editing %n files',
    doneSingular: 'Edited 1 file',
    donePlural: 'Edited %n files'
  },
  'write-files': {
    singular: 'Writing 1 file',
    plural: 'Writing %n files',
    doneSingular: 'Wrote 1 file',
    donePlural: 'Wrote %n files'
  },
  'run-commands': {
    singular: 'Running 1 command',
    plural: 'Running %n commands',
    doneSingular: 'Ran 1 command',
    donePlural: 'Ran %n commands'
  },
  'inspect-workspace': {
    singular: 'Inspecting workspace',
    plural: 'Inspecting workspace · %n commands',
    doneSingular: 'Inspected workspace',
    donePlural: 'Inspected workspace · %n commands'
  },
  'search-memory': {
    singular: 'Searching memory',
    plural: 'Searching memory %n times',
    doneSingular: 'Searched memory',
    donePlural: 'Searched memory %n times'
  }
}

function getToolCallSemanticGroup(toolCall: ToolCall): ToolCallSemanticGroup | null {
  switch (toolCall.toolName) {
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
    case 'searchMemory':
      return 'search-memory'
    case 'bash': {
      const details = toolCall.details
      if (
        details &&
        typeof details === 'object' &&
        'command' in details &&
        typeof details.command === 'string'
      ) {
        return resolveBashSemanticGroup(details.command)
      }
      return 'run-commands'
    }
    default:
      return null
  }
}

function getToolCallFilePath(toolCall: ToolCall): string | null {
  if (
    toolCall.toolName !== 'read' &&
    toolCall.toolName !== 'edit' &&
    toolCall.toolName !== 'write'
  ) {
    return null
  }

  const details = toolCall.details
  if (
    details &&
    typeof details === 'object' &&
    'path' in details &&
    typeof details.path === 'string'
  ) {
    return details.path
  }

  return toolCall.inputSummary.trim() || null
}

function isFileMutationGroup(group: ToolCallSemanticGroup): boolean {
  return group === 'edit-files' || group === 'write-files'
}

function shouldCountUniqueFilePaths(group: ToolCallSemanticGroup): boolean {
  return group === 'read-files' || group === 'edit-files' || group === 'write-files'
}

function isPathToolCall(toolCall: ToolCall): boolean {
  return (
    toolCall.toolName === 'read' || toolCall.toolName === 'edit' || toolCall.toolName === 'write'
  )
}

function resolveCompatibleToolCallGroup(input: {
  currentGroup: ToolCallSemanticGroup
  currentFilePaths: Set<string>
  nextGroup: ToolCallSemanticGroup | null
  nextToolCall: ToolCall
  nextReadWillBeEdited: boolean
}): ToolCallSemanticGroup | null {
  if (input.nextGroup === input.currentGroup) {
    return input.currentGroup
  }

  if (
    input.nextGroup === 'search-files' &&
    (input.currentGroup === 'edit-files' || input.currentGroup === 'write-files')
  ) {
    return input.currentGroup
  }

  if (
    (input.currentGroup === 'edit-files' || input.currentGroup === 'write-files') &&
    (input.nextGroup === 'edit-files' || input.nextGroup === 'write-files')
  ) {
    const nextPath = getToolCallFilePath(input.nextToolCall)
    if (nextPath) {
      input.currentFilePaths.add(nextPath)
      return input.currentGroup === 'write-files' || input.nextGroup === 'write-files'
        ? 'write-files'
        : 'edit-files'
    }
  }

  if (
    input.currentGroup === 'edit-files' &&
    input.nextGroup === 'read-files' &&
    input.nextReadWillBeEdited
  ) {
    const nextPath = getToolCallFilePath(input.nextToolCall)
    if (nextPath) {
      input.currentFilePaths.add(nextPath)
      return input.currentGroup
    }
  }

  if (
    input.currentGroup === 'search-files' &&
    (input.nextGroup === 'edit-files' || input.nextGroup === 'write-files')
  ) {
    const nextPath = getToolCallFilePath(input.nextToolCall)
    if (nextPath) {
      input.currentFilePaths.add(nextPath)
    }
    return input.nextGroup
  }

  if (
    input.nextGroup !== 'read-files' &&
    input.nextGroup !== 'edit-files' &&
    input.nextGroup !== 'write-files'
  ) {
    return null
  }

  if (
    input.currentGroup !== 'read-files' &&
    input.currentGroup !== 'edit-files' &&
    input.currentGroup !== 'write-files'
  ) {
    return null
  }

  if (!isFileMutationGroup(input.currentGroup) && !isFileMutationGroup(input.nextGroup)) {
    return null
  }

  const nextPath = getToolCallFilePath(input.nextToolCall)
  if (!nextPath || !input.currentFilePaths.has(nextPath)) {
    return null
  }

  return input.currentGroup === 'write-files' || input.nextGroup === 'write-files'
    ? 'write-files'
    : 'edit-files'
}

export function getToolCallGroupLabel(
  group: ToolCallSemanticGroup,
  count: number,
  done?: boolean
): string {
  const labels = TOOL_CALL_GROUP_LABELS[group]
  if (done) {
    return count === 1 ? labels.doneSingular : labels.donePlural.replace('%n', String(count))
  }
  return count === 1 ? labels.singular : labels.plural.replace('%n', String(count))
}

export function getToolCallGroupDisplayGroup(
  group: ToolCallSemanticGroup,
  toolCalls: ToolCall[]
): ToolCallSemanticGroup {
  if (group !== 'read-files') {
    return group
  }

  return toolCalls.some(isPathToolCall) ? group : 'inspect-workspace'
}

export function getToolCallGroupCount(group: ToolCallSemanticGroup, toolCalls: ToolCall[]): number {
  if (getToolCallGroupDisplayGroup(group, toolCalls) === 'inspect-workspace') {
    return toolCalls.length
  }

  if (!shouldCountUniqueFilePaths(group)) {
    return toolCalls.length
  }

  const countedFiles = new Set<string>()
  for (const toolCall of toolCalls) {
    if (!isPathToolCall(toolCall)) {
      continue
    }
    const filePath = getToolCallFilePath(toolCall)
    countedFiles.add(filePath ? `path:${filePath}` : `tool:${toolCall.id}`)
  }
  return countedFiles.size
}

export function getToolCallGroupFilePaths(
  group: ToolCallSemanticGroup,
  toolCalls: ToolCall[],
  maxCount: number = 5
): string[] {
  if (!shouldCountUniqueFilePaths(group)) {
    return []
  }

  const countedFiles = new Set<string>()
  for (const toolCall of toolCalls) {
    const filePath = getToolCallFilePath(toolCall)
    if (filePath) {
      countedFiles.add(filePath)
    }
  }

  if (countedFiles.size === 0 || countedFiles.size > maxCount) {
    return []
  }

  return [...countedFiles]
}

function isReadTargetEditedLater(input: {
  items: ConversationGroupTimelineItem[]
  startIndex: number
  toolCallById: Map<string, ToolCall>
  textBlockById: Map<string, MessageTextBlockRecord>
  path: string
}): boolean {
  for (let index = input.startIndex; index < input.items.length; index++) {
    const item = input.items[index]!
    if (item.kind === 'assistant-text-block') {
      const textBlock = input.textBlockById.get(item.textBlockId)
      if (!textBlock || textBlock.content.trim()) {
        return false
      }
      continue
    }

    if (item.kind !== 'tool-call') {
      return false
    }

    const toolCall = input.toolCallById.get(item.toolCallId)
    const group = toolCall ? getToolCallSemanticGroup(toolCall) : null
    if (!toolCall || !group) {
      return false
    }

    const filePath = getToolCallFilePath(toolCall)
    if ((group === 'edit-files' || group === 'write-files') && filePath === input.path) {
      return true
    }

    if (group === 'search-files') {
      continue
    }

    if (filePath === input.path && group === 'read-files') {
      continue
    }

    return false
  }

  return false
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
  activeAssistantTextBlocks: MessageTextBlockRecord[]
  visibleToolCalls: ToolCall[]
}): ConversationGroupTimelineItem[] {
  const items: ConversationGroupTimelineItem[] = []

  if (input.hasMemoryRecall) {
    items.push({ kind: 'memory-recall', key: 'memory-recall' })
  }

  const filteredToolCalls = input.visibleToolCalls

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

  for (const toolCall of filteredToolCalls) {
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
  items.push(...mergeConsecutiveToolCalls(sortedItems, filteredToolCalls, textBlockById))

  if (input.showGenerating) {
    items.push({ kind: 'generating', key: 'generating' })
  }

  if (input.showPreparing) {
    items.push({ kind: 'preparing', key: 'preparing' })
  }

  return items
}

const MIN_GROUP_SIZE = 2

/**
 * Single-pass merge: only strictly consecutive same-group tool calls are grouped.
 * Empty text blocks are skipped transparently; any other item breaks the group.
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
    const group = tc ? getToolCallSemanticGroup(tc) : null

    if (!tc || !group) {
      result.push(item)
      i++
      continue
    }

    const collected: { index: number; toolCallId: string }[] = [
      { index: i, toolCallId: item.toolCallId }
    ]
    let collectedGroup = group
    const currentFilePaths = new Set<string>()
    const firstFilePath = getToolCallFilePath(tc)
    if (firstFilePath) {
      currentFilePaths.add(firstFilePath)
    }
    let j = i + 1

    while (j < items.length) {
      const next = items[j]!

      if (next.kind === 'tool-call') {
        const nextTc = toolCallById.get(next.toolCallId)
        const nextGroup = nextTc ? getToolCallSemanticGroup(nextTc) : null
        const nextFilePath = nextTc ? getToolCallFilePath(nextTc) : null
        const nextReadWillBeEdited =
          nextGroup === 'read-files' && nextFilePath
            ? isReadTargetEditedLater({
                items,
                startIndex: j + 1,
                toolCallById,
                textBlockById,
                path: nextFilePath
              })
            : false
        const compatibleGroup = nextTc
          ? resolveCompatibleToolCallGroup({
              currentGroup: collectedGroup,
              currentFilePaths,
              nextGroup,
              nextToolCall: nextTc,
              nextReadWillBeEdited
            })
          : null

        if (compatibleGroup) {
          collectedGroup = compatibleGroup
          if (nextFilePath) {
            currentFilePaths.add(nextFilePath)
          }
          collected.push({ index: j, toolCallId: next.toolCallId })
        } else {
          break
        }
      } else if (next.kind === 'assistant-text-block') {
        const tb = textBlockById.get(next.textBlockId)
        if (!tb || tb.content.trim()) {
          break
        }
        // empty text block — skip, no gap
      } else {
        break
      }

      j++
    }

    if (collected.length >= MIN_GROUP_SIZE) {
      const groupedSet = new Set(collected.map((c) => c.index))
      const lastGroupedIndex = collected[collected.length - 1]!.index

      result.push({
        kind: 'tool-call-group',
        key: `tool-group:${collected[0]!.toolCallId}`,
        group: collectedGroup,
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
