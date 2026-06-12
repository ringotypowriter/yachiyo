import type {
  MessageFileAttachment,
  MessageImageRecord,
  MessageRecord,
  ThreadRecord,
  ToolCallRecord
} from '@yachiyo/shared/protocol'

export interface CreateSeamlessHandoffDumpInput {
  thread: ThreadRecord
  activePathMessages: MessageRecord[]
  toolCalls: ToolCallRecord[]
  checkpointMessageId: string
  previousWatermarkMessageId?: string
}

export interface SeamlessHandoffDump {
  markdown: string
  segmentMessages: MessageRecord[]
}

function sanitizeFenceContent(content: string): string {
  return content.replaceAll('```', '``\u200b`')
}

function roleLabel(role: MessageRecord['role']): string {
  if (role === 'assistant') return 'Assistant'
  if (role === 'user') return 'User'
  return String(role)
}

function formatRefField(label: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  return `${label}: ${String(value)}`
}

function formatImageRef(image: MessageImageRecord, index: number): string {
  const fields = [
    formatRefField('filename', image.filename),
    formatRefField('mediaType', image.mediaType),
    formatRefField('workspacePath', image.workspacePath),
    formatRefField('attachmentIndex', image.attachmentIndex),
    formatRefField('altText', image.altText)
  ].filter((field): field is string => field != null)
  return `- image ${index + 1}: ${fields.join('; ')}`
}

function formatAttachmentRef(attachment: MessageFileAttachment, index: number): string {
  const fields = [
    formatRefField('filename', attachment.filename),
    formatRefField('mediaType', attachment.mediaType),
    formatRefField('workspacePath', attachment.workspacePath),
    formatRefField('attachmentIndex', attachment.attachmentIndex)
  ].filter((field): field is string => field != null)
  return `- attachment ${index + 1}: ${fields.join('; ')}`
}

function formatMessageRefs(message: MessageRecord): string[] {
  const lines: string[] = []
  if (message.images?.length) {
    lines.push('', 'Image references:', ...message.images.map(formatImageRef))
  }
  if (message.attachments?.length) {
    lines.push('', 'Attachment references:', ...message.attachments.map(formatAttachmentRef))
  }
  return lines
}

function findSegmentMessages(input: CreateSeamlessHandoffDumpInput): MessageRecord[] {
  const checkpointIndex = input.activePathMessages.findIndex(
    (message) => message.id === input.checkpointMessageId
  )
  if (checkpointIndex < 0) return []

  const throughCheckpoint = input.activePathMessages.slice(0, checkpointIndex + 1)
  if (!input.previousWatermarkMessageId) return throughCheckpoint

  const previousWatermarkIndex = throughCheckpoint.findIndex(
    (message) => message.id === input.previousWatermarkMessageId
  )
  if (previousWatermarkIndex < 0) return throughCheckpoint
  return throughCheckpoint.slice(previousWatermarkIndex + 1)
}

function toolBelongsToMessage(toolCall: ToolCallRecord, message: MessageRecord): boolean {
  if (toolCall.assistantMessageId === message.id) return true
  return (
    message.role === 'user' &&
    toolCall.assistantMessageId == null &&
    toolCall.requestMessageId === message.id
  )
}

function collectToolCallsForMessage(input: {
  message: MessageRecord
  segmentMessageIds: ReadonlySet<string>
  toolCalls: readonly ToolCallRecord[]
  usedToolCallIds: Set<string>
}): ToolCallRecord[] {
  const result: ToolCallRecord[] = []
  for (const toolCall of input.toolCalls) {
    if (input.usedToolCallIds.has(toolCall.id)) continue
    const isInSegment =
      (toolCall.requestMessageId != null &&
        input.segmentMessageIds.has(toolCall.requestMessageId)) ||
      (toolCall.assistantMessageId != null &&
        input.segmentMessageIds.has(toolCall.assistantMessageId))
    if (!isInSegment || !toolBelongsToMessage(toolCall, input.message)) continue
    input.usedToolCallIds.add(toolCall.id)
    result.push(toolCall)
  }
  return result.sort((left, right) => left.startedAt.localeCompare(right.startedAt))
}

function appendToolCall(lines: string[], toolCall: ToolCallRecord): void {
  lines.push(`- Tool call \`${toolCall.id}\``)
  lines.push(`  - tool: \`${toolCall.toolName}\``)
  lines.push(`  - status: ${toolCall.status}`)
  if (toolCall.cwd) lines.push(`  - cwd: \`${toolCall.cwd}\``)
  if (toolCall.inputSummary) lines.push(`  - input: ${toolCall.inputSummary}`)
  if (toolCall.outputSummary) lines.push(`  - output: ${toolCall.outputSummary}`)
  if (toolCall.error) lines.push(`  - error: ${toolCall.error}`)
}

export function createSeamlessHandoffDump(
  input: CreateSeamlessHandoffDumpInput
): SeamlessHandoffDump {
  const segmentMessages = findSegmentMessages(input)
  const segmentMessageIds = new Set(segmentMessages.map((message) => message.id))
  const usedToolCallIds = new Set<string>()
  const lines: string[] = [
    '# Active run context handoff dump',
    '',
    `Thread: ${input.thread.title || input.thread.id}`,
    `Thread ID: \`${input.thread.id}\``,
    `Checkpoint message: \`${input.checkpointMessageId}\``,
    ...(input.previousWatermarkMessageId
      ? [`Previous watermark: \`${input.previousWatermarkMessageId}\``]
      : []),
    '',
    'This file preserves message and tool-call references for context recovery. It omits implementation metadata and usage accounting.',
    ''
  ]

  if (segmentMessages.length === 0) {
    lines.push('No messages were found between the previous watermark and the checkpoint.')
    return { markdown: `${lines.join('\n')}\n`, segmentMessages }
  }

  for (const message of segmentMessages) {
    lines.push(`## ${roleLabel(message.role)} message \`${message.id}\``)
    lines.push('')
    lines.push(`Created: ${message.createdAt}`)
    lines.push(`Status: ${message.status}`)
    lines.push('')
    lines.push('```text')
    lines.push(sanitizeFenceContent(message.visibleReply ?? message.content))
    lines.push('```')
    lines.push(...formatMessageRefs(message))

    const toolCalls = collectToolCallsForMessage({
      message,
      segmentMessageIds,
      toolCalls: input.toolCalls,
      usedToolCallIds
    })
    if (toolCalls.length > 0) {
      lines.push('', 'Tool calls:')
      for (const toolCall of toolCalls) appendToolCall(lines, toolCall)
    }
    lines.push('')
  }

  return { markdown: `${lines.join('\n').trimEnd()}\n`, segmentMessages }
}
