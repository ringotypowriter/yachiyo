import type { MessageRecord, ToolCallRecord } from '../../../../shared/yachiyo/protocol.ts'
import type { RunRecoveryCheckpoint } from '../../storage/storage.ts'

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

export function buildRecoveryResponseMessages(input: {
  checkpoint: Pick<RunRecoveryCheckpoint, 'content' | 'reasoning'>
  toolCalls: ToolCallRecord[]
}): unknown[] | undefined {
  const completedToolCalls = [...input.toolCalls]
    .filter((toolCall) => toolCall.finishedAt && toolCall.status === 'completed')
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt))

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
