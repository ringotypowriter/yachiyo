import type { ToolCallRecord } from '@yachiyo/shared/protocol'
import type { RunRecoveryCheckpoint } from '../../../../storage/storage.ts'
import { balanceRecoveryResponseMessages, cloneRecoveryResponseMessages } from '../runRecovery.ts'

/** A new provider request cannot continue a partially emitted generation exactly. */
export function rewindRecoveryOutput(
  checkpoint: RunRecoveryCheckpoint,
  toolCalls: ToolCallRecord[]
): RunRecoveryCheckpoint {
  // Legacy checkpoints have no reliable text boundary; keep their tool records,
  // but regenerate the answer rather than treating partial text as completed.
  const messages = cloneRecoveryResponseMessages(checkpoint.responseMessages) ?? []

  // Keep tool calls/results (including failed calls), but regenerate text after
  // the last tool boundary. Do this before balancing missing tool records: those
  // records must not turn an interrupted answer into preserved output.
  let reachedToolBoundary = false
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'assistant' || reachedToolBoundary) continue
    const toolIndex = message.content.findLastIndex((part) => part.type === 'tool-call')
    if (toolIndex < 0) {
      messages.splice(index, 1)
    } else {
      message.content = message.content.slice(0, toolIndex + 1)
      reachedToolBoundary = true
    }
  }

  const parts = messages.flatMap((message) => (message.role === 'assistant' ? message.content : []))
  const content = parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  const reasoning = parts.flatMap((part) => (part.type === 'reasoning' ? [part.text] : [])).join('')
  let remaining = content.length
  const textBlocks = (checkpoint.textBlocks ?? []).flatMap((block) => {
    const text = block.content.slice(0, remaining)
    remaining -= text.length
    return text ? [{ ...block, content: text }] : []
  })

  return {
    ...checkpoint,
    content,
    reasoning: reasoning || undefined,
    textBlocks,
    responseMessages: balanceRecoveryResponseMessages(messages, toolCalls)
  }
}
