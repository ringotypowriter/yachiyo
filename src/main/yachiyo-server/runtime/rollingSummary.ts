/**
 * Rolling summary generation for external channel threads.
 *
 * Instead of compacting to a new thread (like local desktop handoff),
 * external channels generate a compact, external-safe summary of the
 * conversation state and store it in-place on the thread record.
 *
 * The summary captures what the external user actually experienced —
 * active topic, established facts, unresolved questions, pending next steps.
 * It explicitly excludes internal tool traces, workspace paths, and hidden reasoning.
 */

import type { MessageRecord } from '../../../shared/yachiyo/protocol.ts'
import { prepareModelMessages } from './messagePrepare.ts'
import { SYSTEM_PROMPT } from './prompt.ts'
import type { ModelMessage } from './types.ts'

const ROLLING_SUMMARY_PROMPT = `Summarize the current state of this conversation for seamless continuation.

Capture:
- The active topic and what the conversation is about
- Established facts, decisions, and conclusions the user knows about
- Unresolved questions or pending items
- The user's current intent or what they were working toward

Do NOT include:
- Tool calls, tool results, or internal reasoning traces
- File paths, workspace details, or system internals
- Formatting artifacts or transport-layer details (e.g. <reply> tags)
- Anything the user did not directly see or establish

Write in the same language as the conversation.
Be compact — aim for under 800 tokens.
Output only the summary, with no preamble or meta-commentary.`

function toHistoryMessage(
  message: MessageRecord
): Pick<MessageRecord, 'content' | 'images' | 'role'> {
  // For assistant messages with a visible reply, use that instead of the raw content.
  // This ensures the summary is built from what the user actually received.
  const content =
    message.role === 'assistant' && message.visibleReply ? message.visibleReply : message.content

  return {
    role: message.role,
    content,
    ...(message.images ? { images: message.images } : {})
  }
}

export function buildRollingSummaryMessages(input: {
  history: MessageRecord[]
  userDocumentContent?: string
}): ModelMessage[] {
  return [
    ...prepareModelMessages({
      personality: { basePersona: SYSTEM_PROMPT },
      user: { content: input.userDocumentContent ?? '' },
      history: input.history.map(toHistoryMessage)
    }),
    {
      role: 'user',
      content:
        input.history.length > 0
          ? ROLLING_SUMMARY_PROMPT
          : `${ROLLING_SUMMARY_PROMPT}\n\nThe conversation has barely started. Say that clearly and keep the summary very short.`
    }
  ]
}
