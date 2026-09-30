import { isPlanDocumentMessage, stripPlanDocumentMarker } from '../planMode.ts'
import type { MessageRecord, RunRecord, ThreadRecord, ToolCallRecord } from '../protocol.ts'
import { getThreadCapabilities } from '../protocol.ts'
import type { TodoItemRecord } from '../protocol/events.ts'
import {
  REMOTE_THREAD_PREVIEW_LIMIT,
  REMOTE_TOOL_PREVIEW_LIMIT,
  type RemoteMessage,
  type RemoteThreadSummary,
  type RemoteToolCall
} from './projections.ts'

// Pure record → wire projections shared by the runtime host ops and the main-process event hub.
// They drop everything the phone must not see (response transcripts, turn context, data URLs).

function truncate(value: string, limit: number): { text: string; truncated: boolean } {
  return value.length > limit
    ? { text: value.slice(0, limit), truncated: true }
    : { text: value, truncated: false }
}

function previewOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function workspaceNameOf(workspacePath: string | undefined): string | undefined {
  const trimmed = workspacePath?.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return undefined
  return trimmed.split(/[\\/]/).at(-1) || trimmed
}

export function projectThreadSummary(
  thread: ThreadRecord,
  state: { latestRun?: RunRecord; needsAttention: boolean }
): RemoteThreadSummary {
  const capabilities = getThreadCapabilities(thread)
  const workspaceName = workspaceNameOf(thread.workspacePath)
  const preview = thread.preview?.trim()
  return {
    id: thread.id,
    title: thread.title,
    ...(thread.icon ? { icon: thread.icon } : {}),
    ...(thread.colorTag ? { colorTag: thread.colorTag } : {}),
    starred: Boolean(thread.starredAt),
    updatedAt: thread.updatedAt,
    ...(workspaceName ? { workspaceName } : {}),
    ...(thread.workspacePath ? { workspacePath: thread.workspacePath } : {}),
    ...(state.latestRun
      ? {
          latestRun: {
            runId: state.latestRun.id,
            status: state.latestRun.status,
            startedAt: state.latestRun.createdAt
          }
        }
      : {}),
    needsAttention: state.needsAttention,
    ...(preview ? { preview: preview.slice(0, REMOTE_THREAD_PREVIEW_LIMIT) } : {}),
    capabilities: {
      canRetry: capabilities.canRetry,
      canCreateBranch: capabilities.canCreateBranch,
      canSelectReplyBranch: capabilities.canSelectReplyBranch,
      canEdit: capabilities.canEdit,
      canSend: !thread.syncOriginDeviceId
    },
    ...(thread.syncOriginDeviceId ? { syncOriginDeviceId: thread.syncOriginDeviceId } : {}),
    ...(thread.privacyMode ? { privacyMode: true } : {})
  }
}

function responseContentOrder(message: MessageRecord): string[] | undefined {
  const blocks = message.textBlocks
  if (!blocks?.length || !message.responseMessages?.length) return undefined
  const order: string[] = []
  let textIndex = 0
  for (const response of message.responseMessages) {
    if (
      !response ||
      typeof response !== 'object' ||
      !('role' in response) ||
      response.role !== 'assistant' ||
      !('content' in response) ||
      !Array.isArray(response.content)
    )
      continue
    for (const part of response.content) {
      if (!part || typeof part !== 'object') continue
      if (
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string'
      ) {
        const block = blocks[textIndex++]
        if (block?.content !== part.text) return undefined
        order.push(block.id)
      } else if (
        'type' in part &&
        part.type === 'tool-call' &&
        'toolCallId' in part &&
        typeof part.toolCallId === 'string'
      ) {
        order.push(part.toolCallId)
      }
    }
  }
  return textIndex === blocks.length ? order : undefined
}

/** Returns null for messages hidden from the timeline. */
export function projectMessage(
  message: MessageRecord,
  siblingIds?: string[]
): RemoteMessage | null {
  if (message.hidden) return null
  const isPlanDocument = message.role === 'assistant' && isPlanDocumentMessage(message.content)
  const requestKind = message.turnContext?.hiddenRequestKind
  const contentOrder = isPlanDocument ? undefined : responseContentOrder(message)
  return {
    id: message.id,
    ...(message.parentMessageId ? { parentMessageId: message.parentMessageId } : {}),
    role: message.role,
    content: isPlanDocument ? stripPlanDocumentMarker(message.content) : message.content,
    ...(!isPlanDocument && message.textBlocks?.length ? { textBlocks: message.textBlocks } : {}),
    ...(contentOrder ? { contentOrder } : {}),
    ...(message.reasoning ? { reasoning: message.reasoning } : {}),
    images: (message.images ?? []).map((image, index) => ({
      imageId: String(index),
      mediaType: image.mediaType,
      ...(image.filename ? { filename: image.filename } : {}),
      ...(image.altText ? { altText: image.altText } : {})
    })),
    attachments: (message.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      mediaType: attachment.mediaType
    })),
    status: message.status,
    createdAt: message.createdAt,
    ...(message.modelId ? { modelId: message.modelId } : {}),
    ...(message.providerName ? { providerName: message.providerName } : {}),
    ...(siblingIds ? { siblingIds } : {}),
    isPlanDocument,
    ...(requestKind ? { requestKind } : {})
  }
}

export function projectToolCall(toolCall: ToolCallRecord): RemoteToolCall {
  const input = truncate(previewOf(toolCall.rawInput) ?? '', REMOTE_TOOL_PREVIEW_LIMIT)
  const output = truncate(
    toolCall.outputSummary ?? previewOf(toolCall.rawOutput) ?? '',
    REMOTE_TOOL_PREVIEW_LIMIT
  )
  const details = toolCall.details
  const question =
    details && 'kind' in details && details.kind === 'askUser'
      ? {
          question: details.question,
          ...(details.choices ? { choices: details.choices } : {}),
          ...(details.answer ? { answer: details.answer } : {})
        }
      : undefined
  return {
    id: toolCall.id,
    ...(toolCall.runId ? { runId: toolCall.runId } : {}),
    ...(toolCall.requestMessageId ? { requestMessageId: toolCall.requestMessageId } : {}),
    ...(toolCall.assistantMessageId ? { assistantMessageId: toolCall.assistantMessageId } : {}),
    toolName: toolCall.toolName,
    status: toolCall.status,
    title: toolCall.inputSummary.slice(0, 500),
    ...(toolCall.deckSummary ? { deckSummary: toolCall.deckSummary } : {}),
    ...(input.text ? { inputPreview: input.text } : {}),
    ...(output.text ? { outputPreview: output.text } : {}),
    truncated: input.truncated || output.truncated,
    ...(toolCall.error ? { error: toolCall.error.slice(0, REMOTE_TOOL_PREVIEW_LIMIT) } : {}),
    ...(question ? { question } : {}),
    startedAt: toolCall.startedAt,
    ...(toolCall.finishedAt ? { finishedAt: toolCall.finishedAt } : {})
  }
}

export function projectTodoItems(items: TodoItemRecord[] | undefined): TodoItemRecord[] {
  return (items ?? []).map(({ id, content, status }) => ({ id, content, status }))
}
