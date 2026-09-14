import type { Message, RunRecord, ToolCall } from '@renderer/app/types'
import { stripPlanDocumentMarker, isPlanModeExitRecord } from '@yachiyo/shared/planMode'
import { compareToolCallsChronologically } from '@yachiyo/shared/toolCallOrder'
import {
  buildAssistantResponseTimelineTrace,
  collectResponseMessageToolTrace,
  type MessageGroup
} from '../timeline/messageThreadPresentation'
import {
  getActiveAssistantMessages,
  resolveAssistantTextBlocks
} from '../timeline/messageTimelineRows'
import { buildChronologicalTimelineItems } from '../timeline/messageTimelineLayout'

export interface ResponseShareTextBlock {
  readonly kind: 'text'
  readonly id: string
  readonly content: string
  readonly attachmentNames?: readonly string[]
}
export type ResponseShareBlock =
  | ResponseShareTextBlock
  | {
      readonly kind: 'user'
      readonly id: string
      readonly content: string
      readonly attachmentNames?: readonly string[]
    }
  | { readonly kind: 'tool'; readonly id: string; readonly toolCall: ToolCall }

export interface ResponseShareSnapshot {
  readonly id: string
  readonly question: ResponseShareTextBlock | null
  readonly workspacePath?: string
  readonly threadId?: string
  readonly blocks: readonly ResponseShareBlock[]
  readonly status: 'completed' | 'failed' | 'stopped'
}

export interface ResponseShareInput {
  group?: MessageGroup
  rootMessage?: Message
  messages: readonly Message[]
  toolCalls: readonly ToolCall[]
  runs: readonly RunRecord[]
  activeRequestMessageId?: string | null
  workspacePath?: string
}

function visibleUserContent(message: Message): { content: string; attachmentNames?: string[] } {
  const attachmentNames = [
    ...(message.images ?? []).map((image, index) => image.filename ?? `Image ${index + 1}`),
    ...(message.attachments ?? []).map((attachment) => attachment.filename)
  ]
  return { content: message.content, ...(attachmentNames.length ? { attachmentNames } : {}) }
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) freezeDeep(child)
  }
  return value
}

/** Capture only the selected response, never the timeline's intentionally broader failed-branch tools. */
function buildResponseShareData(input: ResponseShareInput): ResponseShareSnapshot | null {
  const { group } = input
  const selectedMessages = group
    ? getActiveAssistantMessages(group)
    : input.rootMessage
      ? [input.rootMessage]
      : []
  const selected = selectedMessages.filter(
    (message) => !message.hidden && !isPlanModeExitRecord(message)
  )
  if (selectedMessages.length > 0 && selected.length === 0) return null
  const assistants = selected
  if (selected.some((message) => message.status === 'streaming')) return null
  const selectedIds = new Set(selected.map((message) => message.id))
  const messagesById = new Map(
    [...input.messages, ...(group?.userSteerMessages ?? []), ...selected].map((message) => [
      message.id,
      message
    ])
  )
  const ancestorIds = new Set<string>()
  for (const message of selected) {
    let parentId = message.parentMessageId
    while (parentId && !ancestorIds.has(parentId)) {
      ancestorIds.add(parentId)
      if (parentId === group?.userMessage.id) break
      parentId = messagesById.get(parentId)?.parentMessageId
    }
  }
  const requestIds = new Set(
    group
      ? [
          group.userMessage.id,
          ...group.hiddenRequestMessageIds.filter((id) => ancestorIds.has(id)),
          ...group.userSteerMessages
            .filter((message) => ancestorIds.has(message.id))
            .map((message) => message.id)
        ]
      : []
  )
  const trace = collectResponseMessageToolTrace(
    selected.flatMap((message) => message.responseMessages ?? [])
  )
  const otherTraceIds = new Set(
    input.messages
      .filter((message) => message.role === 'assistant' && !selectedIds.has(message.id))
      .flatMap((message) => [...collectResponseMessageToolTrace(message.responseMessages).keys()])
  )
  // A run is provably selected when an authoritative tool anchor identifies it. For
  // legacy history without anchors, accept only one run and no sibling response.
  const selectedRunIds = new Set(
    input.toolCalls
      .filter(
        (tool) =>
          trace.has(tool.id) ||
          (!otherTraceIds.has(tool.id) &&
            !!tool.assistantMessageId &&
            selectedIds.has(tool.assistantMessageId))
      )
      .flatMap((tool) => (tool.runId ? [tool.runId] : []))
  )
  const candidateRuns = input.runs.filter(
    (run) => !!run.requestMessageId && requestIds.has(run.requestMessageId)
  )
  const hasSibling = input.messages.some(
    (message) =>
      message.role === 'assistant' &&
      !selectedIds.has(message.id) &&
      !!message.parentMessageId &&
      requestIds.has(message.parentMessageId)
  )
  if (!hasSibling && candidateRuns.length === 1) selectedRunIds.add(candidateRuns[0]!.id)
  if (input.runs.some((run) => selectedRunIds.has(run.id) && run.status === 'running')) return null
  if (!hasSibling && input.activeRequestMessageId && requestIds.has(input.activeRequestMessageId))
    return null
  const tools = input.toolCalls
    .filter((tool) => {
      if (trace.has(tool.id)) return true
      if (otherTraceIds.has(tool.id)) return false
      if (tool.assistantMessageId) return selectedIds.has(tool.assistantMessageId)
      return (
        !!tool.runId &&
        selectedRunIds.has(tool.runId) &&
        !!tool.requestMessageId &&
        requestIds.has(tool.requestMessageId)
      )
    })
    .map((tool) => {
      const recorded = trace.get(tool.id)
      return {
        ...tool,
        ...(recorded?.input !== undefined ? { rawInput: recorded.input } : {}),
        ...(recorded?.output !== undefined ? { rawOutput: recorded.output } : {})
      }
    })
    .sort(compareToolCallsChronologically)
  const textByAssistant = new Map(
    assistants.map((message) => [
      message.id,
      resolveAssistantTextBlocks(message).map((block) => ({
        ...block,
        content: stripPlanDocumentMarker(block.content)
      }))
    ])
  )
  const texts = [...textByAssistant.values()].flat().filter((block) => block.content.trim())
  const textById = new Map(texts.map((block) => [block.id, block]))
  const toolById = new Map(tools.map((tool) => [tool.id, tool]))
  const ordered = buildChronologicalTimelineItems({
    activeAssistantTextBlocks: texts,
    visibleToolCalls: tools,
    sourceTrace: buildAssistantResponseTimelineTrace({
      assistantMessages: assistants,
      textBlocksByAssistantMessageId: textByAssistant,
      toolCalls: tools
    })
  })
  const blocks: ResponseShareBlock[] = []
  const followups = (group?.userSteerMessages ?? [])
    .filter((message) => !message.hidden && ancestorIds.has(message.id))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  let followupIndex = 0
  for (const item of ordered) {
    const text = item.kind === 'assistant-text-block' ? textById.get(item.textBlockId) : undefined
    const tool = item.kind === 'tool-call' ? toolById.get(item.toolCallId) : undefined
    const time = text?.createdAt ?? tool?.startedAt
    while (
      time &&
      followupIndex < followups.length &&
      followups[followupIndex]!.createdAt <= time
    ) {
      const message = followups[followupIndex++]!
      blocks.push({ kind: 'user', id: message.id, ...visibleUserContent(message) })
    }
    if (text) blocks.push({ kind: 'text', id: text.id, content: text.content })
    if (tool) blocks.push({ kind: 'tool', id: tool.id, toolCall: tool })
  }
  for (const message of followups.slice(followupIndex))
    blocks.push({ kind: 'user', id: message.id, ...visibleUserContent(message) })
  if (!blocks.some((block) => block.kind !== 'user')) return null
  const last = selected.at(-1)
  const lastRun = candidateRuns.filter((run) => selectedRunIds.has(run.id)).at(-1)
  const status =
    last?.status === 'failed' || last?.status === 'stopped'
      ? last.status
      : !last && lastRun?.status === 'failed'
        ? 'failed'
        : !last && lastRun?.status === 'cancelled'
          ? 'stopped'
          : 'completed'
  const question =
    group && !group.userMessage.hidden
      ? {
          kind: 'text' as const,
          id: group.userMessage.id,
          ...visibleUserContent(group.userMessage)
        }
      : null
  return {
    id: selected[0]?.id ?? group!.userMessage.id,
    question,
    blocks,
    status,
    threadId: last?.threadId ?? group?.userMessage.threadId,
    workspacePath: input.workspacePath
  }
}

/** Avoid cloning potentially large raw tool payloads during row rendering. */
export function canShareResponseImage(input: ResponseShareInput): boolean {
  return buildResponseShareData(input) !== null
}

export function buildResponseShareSnapshot(
  input: ResponseShareInput
): ResponseShareSnapshot | null {
  const data = buildResponseShareData(input)
  return data ? freezeDeep(structuredClone(data)) : null
}
