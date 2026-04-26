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

const ROLLING_SUMMARY_PROMPT = `You have been working on the task described above but have not yet completed it.

Write a continuation summary so that you — or another instance of yourself — can resume this task seamlessly in a new context window where the full conversation history will no longer be available. Write as if handing off mid-task to a colleague who needs to pick up exactly where you left off.

Structure your summary as follows:

**1. User's Last Query**
Copy or closely paraphrase the user's most recent request or question. This is the active thread — the resuming agent must address this first without asking for clarification again.

**2. Task Overview**
The user's core goal and success criteria. Any constraints, preferences, or scope limits they specified.

**3. Current State**
What has already been completed. Files created, modified, or analyzed (with paths). Key outputs or artifacts produced so far.

**4. Key Discoveries**
Technical constraints or requirements uncovered during the work. Decisions made and their rationale. Errors encountered and how they were resolved. Approaches tried that did not work, and why.

**5. Next Steps**
Concrete actions needed to complete the task, in priority order. Any blockers or open questions that need resolution first.

**6. Context to Preserve**
User preferences, style requirements, domain-specific details, and any explicit promises made.

**Language continuity is mandatory.** Detect the language used in the most recent assistant message and write the entire summary in that same language. The language of these instructions does not matter — only the conversation's language does.
Be concise but complete — err on the side of including anything that prevents duplicate work or repeated mistakes. Wrap your summary in <summary></summary> tags.`

type SummaryHistoryMessage = Pick<MessageRecord, 'content' | 'images' | 'role'> & {
  visibleReply?: string
}

function toHistoryMessage(
  message: SummaryHistoryMessage
): Pick<MessageRecord, 'content' | 'images' | 'role'> {
  const content =
    message.role === 'assistant' && message.visibleReply ? message.visibleReply : message.content

  return {
    role: message.role,
    content,
    ...(message.images ? { images: message.images } : {})
  }
}

export function buildRollingSummaryMessages(input: {
  history: SummaryHistoryMessage[]
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
