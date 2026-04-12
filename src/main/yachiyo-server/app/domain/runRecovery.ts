import type { AgentToolOutput } from '../../tools/agentTools.ts'
import type { MessageRecord, ToolCallRecord } from '../../../../shared/yachiyo/protocol.ts'
import type { RunRecoveryCheckpoint } from '../../storage/storage.ts'

interface RecoveryAssistantReasoningPart {
  type: 'reasoning'
  text: string
}

interface RecoveryAssistantTextPart {
  type: 'text'
  text: string
}

interface RecoveryAssistantToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: ToolCallRecord['toolName']
  input: unknown
}

type RecoveryAssistantPart =
  | RecoveryAssistantReasoningPart
  | RecoveryAssistantTextPart
  | RecoveryAssistantToolCallPart

interface RecoveryAssistantMessage {
  role: 'assistant'
  content: RecoveryAssistantPart[]
}

interface RecoveryToolResultPart {
  type: 'tool-result'
  toolCallId: string
  toolName: ToolCallRecord['toolName']
  output: unknown
}

interface RecoveryToolMessage {
  role: 'tool'
  content: RecoveryToolResultPart[]
}

export type RecoveryResponseMessage = RecoveryAssistantMessage | RecoveryToolMessage

interface RecordedToolCallIds {
  toolCalls: Set<string>
  toolResults: Set<string>
}

function ensureAssistantMessage(
  responseMessages: RecoveryResponseMessage[]
): RecoveryAssistantMessage {
  const lastMessage = responseMessages.at(-1)
  if (lastMessage?.role === 'assistant') {
    return lastMessage
  }

  const assistantMessage: RecoveryAssistantMessage = {
    role: 'assistant',
    content: []
  }
  responseMessages.push(assistantMessage)
  return assistantMessage
}

function appendAssistantTextPart(
  responseMessages: RecoveryResponseMessage[],
  part: RecoveryAssistantReasoningPart | RecoveryAssistantTextPart
): RecoveryResponseMessage[] {
  if (!part.text) {
    return responseMessages
  }

  const assistantMessage = ensureAssistantMessage(responseMessages)
  const lastPart = assistantMessage.content.at(-1)

  if (lastPart?.type === part.type) {
    lastPart.text += part.text
    return responseMessages
  }

  assistantMessage.content.push(part)
  return responseMessages
}

function toRecoveryToolResultOutput(input: { output?: unknown; error?: unknown }): unknown {
  const toolOutput = input.output as Partial<AgentToolOutput> | undefined

  if (Array.isArray(toolOutput?.content)) {
    return {
      type: 'content',
      value: structuredClone(toolOutput.content)
    }
  }

  const errorMessage =
    input.error instanceof Error
      ? input.error.message
      : typeof input.error === 'string'
        ? input.error
        : typeof toolOutput?.error === 'string'
          ? toolOutput.error
          : undefined

  if (errorMessage) {
    return {
      type: 'content',
      value: [{ type: 'text', text: errorMessage }]
    }
  }

  return {
    type: 'content',
    value: [{ type: 'text', text: 'tool completed' }]
  }
}

export function cloneRecoveryResponseMessages(
  responseMessages?: unknown[]
): RecoveryResponseMessage[] | undefined {
  return responseMessages?.length
    ? (structuredClone(responseMessages) as RecoveryResponseMessage[])
    : undefined
}

export function appendRecoveryReasoningDelta(
  responseMessages: RecoveryResponseMessage[],
  reasoningDelta: string
): RecoveryResponseMessage[] {
  return appendAssistantTextPart(responseMessages, { type: 'reasoning', text: reasoningDelta })
}

export function appendRecoveryTextDelta(
  responseMessages: RecoveryResponseMessage[],
  delta: string
): RecoveryResponseMessage[] {
  return appendAssistantTextPart(responseMessages, { type: 'text', text: delta })
}

export function appendRecoveryToolCall(
  responseMessages: RecoveryResponseMessage[],
  input: {
    toolCallId: string
    toolName: ToolCallRecord['toolName']
    toolInput: unknown
  }
): RecoveryResponseMessage[] {
  const assistantMessage = ensureAssistantMessage(responseMessages)
  assistantMessage.content.push({
    type: 'tool-call',
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    input: structuredClone(input.toolInput)
  })
  return responseMessages
}

export function appendRecoveryToolResult(
  responseMessages: RecoveryResponseMessage[],
  input: {
    toolCallId: string
    toolName: ToolCallRecord['toolName']
    output?: unknown
    error?: unknown
  }
): RecoveryResponseMessage[] {
  responseMessages.push({
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        output: toRecoveryToolResultOutput({
          output: input.output,
          error: input.error
        })
      }
    ]
  })
  return responseMessages
}

export function clearRecoveryReasoningParts(
  responseMessages: RecoveryResponseMessage[]
): RecoveryResponseMessage[] {
  const normalizedMessages: RecoveryResponseMessage[] = []

  for (const message of responseMessages) {
    if (message.role !== 'assistant') {
      normalizedMessages.push(message)
      continue
    }

    const content = message.content.filter((part) => part.type !== 'reasoning')
    if (content.length > 0) {
      normalizedMessages.push({
        ...message,
        content
      })
    }
  }

  return normalizedMessages
}

function collectRecordedToolCallIds(
  responseMessages: RecoveryResponseMessage[]
): RecordedToolCallIds {
  const toolCalls = new Set<string>()
  const toolResults = new Set<string>()

  for (const message of responseMessages) {
    if (message.role === 'assistant') {
      for (const part of message.content) {
        if (part.type === 'tool-call') {
          toolCalls.add(part.toolCallId)
        }
      }
      continue
    }

    for (const part of message.content) {
      if (part.type === 'tool-result') {
        toolResults.add(part.toolCallId)
      }
    }
  }

  return { toolCalls, toolResults }
}

function normalizeCompletedToolCalls(
  responseMessages: RecoveryResponseMessage[],
  completedToolCalls: Map<string, ToolCallRecord>
): RecoveryResponseMessage[] {
  const normalizedMessages: RecoveryResponseMessage[] = []

  for (const message of responseMessages) {
    if (message.role === 'assistant') {
      const content = message.content.flatMap((part): RecoveryAssistantPart[] => {
        if (part.type !== 'tool-call') {
          return [part]
        }

        const completedToolCall = completedToolCalls.get(part.toolCallId)
        if (!completedToolCall) {
          return []
        }

        return [
          {
            ...part,
            input: buildInterruptedToolCallInput(completedToolCall)
          }
        ]
      })
      if (content.length > 0) {
        normalizedMessages.push({
          ...message,
          content
        })
      }
      continue
    }

    const content = message.content.flatMap((part): RecoveryToolResultPart[] => {
      const completedToolCall = completedToolCalls.get(part.toolCallId)
      if (!completedToolCall) {
        return []
      }

      return [
        {
          ...part,
          output: buildInterruptedToolCallOutput(completedToolCall)
        }
      ]
    })
    if (content.length > 0) {
      normalizedMessages.push({
        ...message,
        content
      })
    }
  }

  return normalizedMessages
}

function appendMissingCompletedToolCalls(
  responseMessages: RecoveryResponseMessage[],
  completedToolCalls: ToolCallRecord[]
): RecoveryResponseMessage[] {
  const recordedToolCallIds = collectRecordedToolCallIds(responseMessages)

  for (const toolCall of completedToolCalls) {
    if (!recordedToolCallIds.toolCalls.has(toolCall.id)) {
      appendRecoveryToolCall(responseMessages, {
        toolCallId: toolCall.id,
        toolName: toolCall.toolName,
        toolInput: buildInterruptedToolCallInput(toolCall)
      })
      recordedToolCallIds.toolCalls.add(toolCall.id)
    }

    if (!recordedToolCallIds.toolResults.has(toolCall.id)) {
      responseMessages.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: toolCall.id,
            toolName: toolCall.toolName,
            output: buildInterruptedToolCallOutput(toolCall)
          }
        ]
      })
      recordedToolCallIds.toolResults.add(toolCall.id)
    }
  }

  return responseMessages
}

function buildInterruptedToolCallInput(toolCall: ToolCallRecord): unknown {
  const details = toolCall.details

  if (toolCall.toolName === 'read' && details && 'path' in details && 'startLine' in details) {
    return {
      path: details.path
    }
  }

  if (toolCall.toolName === 'write' && details && 'path' in details && 'bytesWritten' in details) {
    return {
      path: details.path
    }
  }

  if (toolCall.toolName === 'edit' && details && 'path' in details && 'replacements' in details) {
    return {
      path: details.path
    }
  }

  if (toolCall.toolName === 'bash' && details && 'command' in details) {
    return {
      command: details.command
    }
  }

  if (toolCall.toolName === 'jsRepl' && details && 'code' in details) {
    return {
      code: details.code,
      ...('contextReset' in details && details.contextReset ? { reset: true } : {})
    }
  }

  if (
    toolCall.toolName === 'grep' &&
    details &&
    'pattern' in details &&
    'matches' in details &&
    'path' in details
  ) {
    return {
      pattern: details.pattern,
      ...(details.path ? { path: details.path } : {})
    }
  }

  if (
    toolCall.toolName === 'glob' &&
    details &&
    'pattern' in details &&
    'matches' in details &&
    'path' in details
  ) {
    return {
      pattern: details.pattern,
      ...(details.path ? { path: details.path } : {})
    }
  }

  if (
    toolCall.toolName === 'webRead' &&
    details &&
    'requestedUrl' in details &&
    'extractor' in details
  ) {
    return {
      url: details.requestedUrl
    }
  }

  if (toolCall.toolName === 'webSearch' && details && 'query' in details && 'results' in details) {
    return {
      query: details.query
    }
  }

  if (
    toolCall.toolName === 'skillsRead' &&
    details &&
    'requestedNames' in details &&
    'skills' in details
  ) {
    return {
      names: details.requestedNames
    }
  }

  if (toolCall.toolName === 'bash') {
    return {
      command: toolCall.inputSummary
    }
  }

  return {
    summary: toolCall.inputSummary
  }
}

function buildInterruptedToolCallOutput(toolCall: ToolCallRecord): unknown {
  if (toolCall.error) {
    return {
      type: 'content',
      value: [{ type: 'text', text: toolCall.error }]
    }
  }

  if (toolCall.toolName === 'bash' && toolCall.details && 'stdout' in toolCall.details) {
    const stdout = toolCall.details.stdout.trim()
    const stderr = 'stderr' in toolCall.details ? toolCall.details.stderr.trim() : ''
    const blocks = [
      ...(stdout ? [{ type: 'text', text: stdout }] : []),
      ...(stderr ? [{ type: 'text', text: stderr }] : [])
    ]

    if (blocks.length > 0) {
      return {
        type: 'content',
        value: blocks
      }
    }
  }

  if (toolCall.outputSummary) {
    return {
      type: 'content',
      value: [{ type: 'text', text: toolCall.outputSummary }]
    }
  }

  return {
    type: 'content',
    value: [{ type: 'text', text: 'tool completed' }]
  }
}

export function balanceRecoveryResponseMessages(
  responseMessages: RecoveryResponseMessage[],
  toolCalls: ToolCallRecord[]
): RecoveryResponseMessage[] {
  // Include any tool call that has reached a terminal state (completed OR failed).
  // Aborts mark in-flight tool calls as `failed`, and the model still needs a
  // matching tool-result for every tool-call we already wrote to the buffer —
  // otherwise the next provider request blows up on the unpaired tool_use.
  const terminalToolCalls = [...toolCalls]
    .filter((toolCall) => toolCall.finishedAt)
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
  const terminalToolCallsById = new Map(
    terminalToolCalls.map((toolCall) => [toolCall.id, toolCall] as const)
  )

  return appendMissingCompletedToolCalls(
    normalizeCompletedToolCalls(responseMessages, terminalToolCallsById),
    terminalToolCalls
  )
}

export function buildRecoveryResponseMessages(input: {
  checkpoint: Pick<RunRecoveryCheckpoint, 'content' | 'reasoning' | 'responseMessages'>
  toolCalls: ToolCallRecord[]
}): unknown[] | undefined {
  const completedToolCalls = [...input.toolCalls]
    .filter((toolCall) => toolCall.finishedAt && toolCall.status === 'completed')
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))

  if (input.checkpoint.responseMessages?.length) {
    return balanceRecoveryResponseMessages(
      cloneRecoveryResponseMessages(input.checkpoint.responseMessages) ?? [],
      input.toolCalls
    )
  }

  if (completedToolCalls.length === 0 && !input.checkpoint.content && !input.checkpoint.reasoning) {
    return undefined
  }

  const assistantContent: unknown[] = []
  if (input.checkpoint.reasoning) {
    assistantContent.push({ type: 'reasoning', text: input.checkpoint.reasoning })
  }
  if (input.checkpoint.content) {
    assistantContent.push({ type: 'text', text: input.checkpoint.content })
  }
  for (const toolCall of completedToolCalls) {
    assistantContent.push({
      type: 'tool-call',
      toolCallId: toolCall.id,
      toolName: toolCall.toolName,
      input: buildInterruptedToolCallInput(toolCall)
    })
  }

  const responseMessages: unknown[] = [
    {
      role: 'assistant',
      content: assistantContent
    }
  ]

  for (const toolCall of completedToolCalls) {
    responseMessages.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: toolCall.id,
          toolName: toolCall.toolName,
          output: buildInterruptedToolCallOutput(toolCall)
        }
      ]
    })
  }

  return responseMessages
}

export function buildRecoveryContinuationPrompt(toolCalls: ToolCallRecord[]): string {
  const interruptedToolLines = toolCalls
    .filter((toolCall) => toolCall.status !== 'completed')
    .map(
      (toolCall) =>
        `- ${toolCall.toolName}: ${toolCall.inputSummary}${toolCall.error ? ` (${toolCall.error})` : ''}`
    )

  if (interruptedToolLines.length === 0) {
    return 'The previous assistant response was interrupted by a recoverable transport failure. Continue the same task from the preserved assistant work above. Do not repeat completed tool calls unless you need fresh information. Continue from the partial answer instead of restarting it.'
  }

  return [
    'The previous assistant response was interrupted by a recoverable transport failure.',
    'Continue the same task from the preserved assistant work above.',
    'Do not repeat completed tool calls unless you need fresh information.',
    'These tool calls were interrupted before they finished, so treat them as unfinished work rather than completed facts:',
    ...interruptedToolLines,
    'Continue from the partial answer instead of restarting it.'
  ].join('\n')
}

export function buildRecoveryHistory(input: {
  checkpoint: RunRecoveryCheckpoint
  toolCalls: ToolCallRecord[]
}): Array<Pick<MessageRecord, 'content' | 'role' | 'responseMessages'>> {
  const responseMessages = buildRecoveryResponseMessages({
    checkpoint: input.checkpoint,
    toolCalls: input.toolCalls
  })

  return [
    {
      role: 'assistant',
      content: input.checkpoint.content,
      ...(responseMessages ? { responseMessages } : {})
    },
    {
      role: 'user',
      content: buildRecoveryContinuationPrompt(input.toolCalls)
    }
  ]
}
