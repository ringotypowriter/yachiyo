import type {
  MessageTextBlockRecord,
  ToolCallRecord
} from '../../../../../../shared/yachiyo/protocol.ts'
import type { RunRecoveryCheckpoint } from '../../../../storage/storage.ts'
import {
  appendRecoveryReasoningDelta,
  appendRecoveryTextDelta,
  appendRecoveryToolCall,
  appendRecoveryToolResult,
  buildRecoveryResponseMessages,
  cloneRecoveryResponseMessages,
  type RecoveryResponseMessage
} from '../../runRecovery.ts'
import { consumeDuplicatePrefix } from './streamDedup.ts'
import { appendMessageDeltaToTextBlocks } from './textBlocks.ts'

interface OutputStateDeps {
  createId: () => string
  timestamp: () => string
}

export interface RunOutputSnapshot {
  content: string
  bufferLength: number
  reasoning?: string
  reasoningLength: number
  textBlocks: MessageTextBlockRecord[]
  recoveryResponseMessages: RecoveryResponseMessage[]
}

export interface RunOutputState {
  appendReasoningDelta: (delta: string) => void
  appendTextDelta: (delta: string) => void
  appendToolCall: (input: { toolCallId: string; toolInput: unknown; toolName: string }) => void
  appendToolResult: (input: {
    error?: unknown
    output: unknown
    toolCallId: string
    toolName: string
  }) => void
  consumeTextDelta: (delta: string) => string | undefined
  getContent: () => string
  getSnapshot: () => RunOutputSnapshot
  hasTextContent: () => boolean
  markNextTextBlock: () => void
  rebuildRecoveryMessages: (toolCalls: ToolCallRecord[]) => void
}

export function createRunOutputState(input: {
  deps: OutputStateDeps
  recoveryCheckpoint?: RunRecoveryCheckpoint
  toolCalls: ToolCallRecord[]
}): RunOutputState {
  const bufferParts: string[] = input.recoveryCheckpoint?.content
    ? [input.recoveryCheckpoint.content]
    : []
  let bufferLength = bufferParts.reduce((sum, part) => sum + part.length, 0)
  const reasoningParts: string[] = input.recoveryCheckpoint?.reasoning
    ? [input.recoveryCheckpoint.reasoning]
    : []
  let reasoningLength = reasoningParts.reduce((sum, part) => sum + part.length, 0)
  let textBlocks: MessageTextBlockRecord[] = input.recoveryCheckpoint?.textBlocks
    ? [...input.recoveryCheckpoint.textBlocks]
    : []
  let shouldStartNewTextBlock = textBlocks.length === 0
  let duplicateTextPrefix = input.recoveryCheckpoint?.content ?? ''
  let pendingDuplicateText = ''
  let recoveryResponseMessages: RecoveryResponseMessage[] =
    (buildRecoveryResponseMessages({
      checkpoint: input.recoveryCheckpoint ?? { content: bufferParts.join('') },
      toolCalls: input.toolCalls
    }) as RecoveryResponseMessage[] | undefined) ?? []

  const getContent = (): string => bufferParts.join('')

  const getSnapshot = (): RunOutputSnapshot => ({
    content: getContent(),
    bufferLength,
    ...(reasoningLength > 0 ? { reasoning: reasoningParts.join('') } : {}),
    reasoningLength,
    textBlocks,
    recoveryResponseMessages
  })

  return {
    appendReasoningDelta: (delta) => {
      reasoningParts.push(delta)
      reasoningLength += delta.length
      appendRecoveryReasoningDelta(recoveryResponseMessages, delta)
    },
    appendTextDelta: (delta) => {
      bufferParts.push(delta)
      bufferLength += delta.length
      appendRecoveryTextDelta(recoveryResponseMessages, delta)
      const nextTextBlockState = appendMessageDeltaToTextBlocks({
        textBlocks,
        delta,
        timestamp: input.deps.timestamp(),
        createId: input.deps.createId,
        shouldStartNewBlock: shouldStartNewTextBlock
      })
      textBlocks = nextTextBlockState.textBlocks
      shouldStartNewTextBlock = nextTextBlockState.shouldStartNewBlock
    },
    appendToolCall: (toolCall) => {
      appendRecoveryToolCall(recoveryResponseMessages, toolCall)
    },
    appendToolResult: (toolResult) => {
      appendRecoveryToolResult(recoveryResponseMessages, toolResult)
    },
    consumeTextDelta: (delta) => {
      const deduped = consumeDuplicatePrefix({
        prefix: duplicateTextPrefix,
        pending: pendingDuplicateText,
        delta
      })
      duplicateTextPrefix = deduped.prefix
      pendingDuplicateText = deduped.pending
      return deduped.delta || undefined
    },
    getContent,
    getSnapshot,
    hasTextContent: () => bufferLength > 0,
    markNextTextBlock: () => {
      shouldStartNewTextBlock = true
    },
    rebuildRecoveryMessages: (toolCalls) => {
      const normalizedResponseMessages = buildRecoveryResponseMessages({
        checkpoint: {
          content: getContent(),
          reasoning: reasoningParts.join(''),
          ...(recoveryResponseMessages.length > 0
            ? { responseMessages: recoveryResponseMessages }
            : {})
        },
        toolCalls
      }) as RecoveryResponseMessage[] | undefined
      recoveryResponseMessages =
        normalizedResponseMessages ??
        cloneRecoveryResponseMessages(input.recoveryCheckpoint?.responseMessages) ??
        []
    }
  }
}
