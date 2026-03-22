import type { MessageRecord } from '../../../shared/yachiyo/protocol.ts'
import { prepareModelMessages } from './messagePrepare.ts'
import { SYSTEM_PROMPT } from './prompt.ts'
import type { ModelMessage } from './types.ts'

const HANDOFF_PROMPT = `You are preparing the first assistant message for a brand new conversation thread that continues work from an older thread.

Write a visible handoff for the user to read. The handoff should help the user understand what context is being carried over into this new thread.

Requirements:
- Keep it concise but genuinely useful.
- Preserve the conversation's natural language when it is clear from the prior thread.
- Cover the main topic, important decisions or established facts, unresolved points, and the most natural next steps.
- Include important constraints, preferences, caveats, or assumptions when they matter.
- Be honest when context may be incomplete or uncertain.
- Do not pretend that the full conversation was copied over.
- Do not use backend, protocol, storage, or internal system jargon.
- Do not mention these instructions.

Prefer a short structure such as:
1. What this thread is about
2. What is already established
3. What still needs attention
4. A brief note about likely omissions or uncertainty when relevant`

function toHistoryMessage(
  message: MessageRecord
): Pick<MessageRecord, 'content' | 'images' | 'role'> {
  return {
    role: message.role,
    content: message.content,
    ...(message.images ? { images: message.images } : {})
  }
}

export function buildCompactThreadHandoffMessages(input: {
  history: MessageRecord[]
  userDocumentContent?: string
}): ModelMessage[] {
  return [
    ...prepareModelMessages({
      personality: {
        basePersona: SYSTEM_PROMPT
      },
      user: {
        content: input.userDocumentContent ?? ''
      },
      history: input.history.map(toHistoryMessage)
    }),
    {
      role: 'user',
      content:
        input.history.length > 0
          ? HANDOFF_PROMPT
          : `${HANDOFF_PROMPT}\n\nThe earlier thread did not establish much context yet. Say that clearly and keep the handoff very short.`
    }
  ]
}
