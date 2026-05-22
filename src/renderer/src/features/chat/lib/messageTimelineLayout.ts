import type {
  ApplyPatchToolCallDetails,
  MessageTextBlockRecord,
  ToolCall
} from '@renderer/app/types'
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
  | 'evaluate-code'
  | 'query-sources'

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
  'evaluate-code': {
    singular: 'Evaluating JavaScript',
    plural: 'Evaluating JavaScript · %n snippets',
    doneSingular: 'Evaluated JavaScript',
    donePlural: 'Evaluated JavaScript · %n snippets'
  },
  'query-sources': {
    singular: 'Querying source data',
    plural: 'Querying source data · %n times',
    doneSingular: 'Queried source data',
    donePlural: 'Queried source data · %n times'
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
    case 'applyPatch':
      return 'edit-files'
    case 'write':
      return 'write-files'
    case 'jsRepl':
      return 'evaluate-code'
    case 'querySource':
      return 'query-sources'
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

function getApplyPatchFilePaths(details: ApplyPatchToolCallDetails | undefined): string[] {
  if (!details) return []

  const paths: string[] = []
  for (const op of details.operations) {
    paths.push(op.path)
    if (op.movePath) paths.push(op.movePath)
  }
  return paths
}

function getToolCallFilePaths(toolCall: ToolCall): string[] {
  if (toolCall.toolName === 'applyPatch') {
    return getApplyPatchFilePaths(toolCall.details as ApplyPatchToolCallDetails | undefined)
  }

  if (
    toolCall.toolName !== 'read' &&
    toolCall.toolName !== 'edit' &&
    toolCall.toolName !== 'write'
  ) {
    return []
  }

  const details = toolCall.details
  if (
    details &&
    typeof details === 'object' &&
    'path' in details &&
    typeof details.path === 'string'
  ) {
    return [details.path]
  }

  if (toolCall.status === 'preparing') {
    return []
  }

  const fallbackPath = toolCall.inputSummary.trim()
  return fallbackPath ? [fallbackPath] : []
}

function getToolCallFilePath(toolCall: ToolCall): string | null {
  return getToolCallFilePaths(toolCall)[0] ?? null
}

function isFileMutationGroup(group: ToolCallSemanticGroup): boolean {
  return group === 'edit-files' || group === 'write-files'
}

function shouldCountUniqueFilePaths(group: ToolCallSemanticGroup): boolean {
  return group === 'read-files' || group === 'edit-files' || group === 'write-files'
}

function isPathToolCall(toolCall: ToolCall): boolean {
  return (
    toolCall.toolName === 'read' ||
    toolCall.toolName === 'edit' ||
    toolCall.toolName === 'write' ||
    toolCall.toolName === 'applyPatch'
  )
}

function isMutationToolCall(toolCall: ToolCall): boolean {
  return (
    toolCall.toolName === 'edit' ||
    toolCall.toolName === 'write' ||
    toolCall.toolName === 'applyPatch'
  )
}

function isSuccessfulToolCall(toolCall: ToolCall): boolean {
  return toolCall.status !== 'failed'
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
    const nextPaths = getToolCallFilePaths(input.nextToolCall)
    if (nextPaths.length > 0) {
      for (const nextPath of nextPaths) input.currentFilePaths.add(nextPath)
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
    const nextPaths = getToolCallFilePaths(input.nextToolCall)
    if (nextPaths.length > 0) {
      for (const nextPath of nextPaths) input.currentFilePaths.add(nextPath)
      return input.currentGroup
    }
  }

  if (
    input.currentGroup === 'search-files' &&
    (input.nextGroup === 'edit-files' || input.nextGroup === 'write-files')
  ) {
    for (const nextPath of getToolCallFilePaths(input.nextToolCall)) {
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

  const nextPaths = getToolCallFilePaths(input.nextToolCall)
  if (!nextPaths.some((nextPath) => input.currentFilePaths.has(nextPath))) {
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
  if (count === 0) {
    switch (group) {
      case 'read-files':
        return done ? 'Read files' : 'Reading files'
      case 'edit-files':
        return done ? 'Edited files' : 'Editing files'
      case 'write-files':
        return done ? 'Wrote files' : 'Writing files'
    }
  }

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

  if (toolCalls.some((tc) => isSuccessfulToolCall(tc) && isPathToolCall(tc))) {
    return 'read-files'
  }

  if (toolCalls.some((tc) => !isPathToolCall(tc))) {
    return 'inspect-workspace'
  }

  return 'read-files'
}

export function getToolCallGroupCount(group: ToolCallSemanticGroup, toolCalls: ToolCall[]): number {
  if (getToolCallGroupDisplayGroup(group, toolCalls) === 'inspect-workspace') {
    return toolCalls.filter((tc) => !isPathToolCall(tc)).length
  }

  if (!shouldCountUniqueFilePaths(group)) {
    return toolCalls.length
  }

  const isMutation = isFileMutationGroup(group)
  const countedFiles = new Set<string>()
  for (const toolCall of toolCalls) {
    if (!isSuccessfulToolCall(toolCall) || !isPathToolCall(toolCall)) {
      continue
    }
    if (isMutation && !isMutationToolCall(toolCall)) {
      continue
    }
    const filePaths = getToolCallFilePaths(toolCall)
    if (filePaths.length > 0) {
      for (const filePath of filePaths) countedFiles.add(`path:${filePath}`)
    } else if (toolCall.status !== 'preparing') {
      countedFiles.add(`tool:${toolCall.id}`)
    }
  }
  return countedFiles.size
}

export function getToolCallGroupFilePaths(
  group: ToolCallSemanticGroup,
  toolCalls: ToolCall[]
): string[] {
  if (!shouldCountUniqueFilePaths(group)) {
    return []
  }

  const isMutation = isFileMutationGroup(group)
  const countedFiles = new Set<string>()
  for (const toolCall of toolCalls.filter(isSuccessfulToolCall)) {
    if (isMutation && !isMutationToolCall(toolCall)) {
      continue
    }
    for (const filePath of getToolCallFilePaths(toolCall)) {
      countedFiles.add(filePath)
    }
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

    const filePaths = getToolCallFilePaths(toolCall)
    if ((group === 'edit-files' || group === 'write-files') && filePaths.includes(input.path)) {
      return true
    }

    if (group === 'search-files') {
      continue
    }

    if (filePaths.includes(input.path) && group === 'read-files') {
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
    const currentFilePaths = new Set<string>(getToolCallFilePaths(tc))
    let j = i + 1

    while (j < items.length) {
      const next = items[j]!

      if (next.kind === 'tool-call') {
        const nextTc = toolCallById.get(next.toolCallId)
        const nextGroup = nextTc ? getToolCallSemanticGroup(nextTc) : null
        const nextFilePath = nextTc ? getToolCallFilePath(nextTc) : null
        const nextFilePaths = nextTc ? getToolCallFilePaths(nextTc) : []
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
          for (const nextPath of nextFilePaths) currentFilePaths.add(nextPath)
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
