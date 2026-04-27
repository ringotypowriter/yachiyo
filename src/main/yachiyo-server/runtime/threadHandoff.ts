import type { ContextLayerHistoryMessage } from './contextLayers.ts'
import { prepareModelMessages } from './messagePrepare.ts'
import { SYSTEM_PROMPT } from './prompt.ts'
import type { CompileContextLayersInput } from './contextLayers.ts'
import type { ModelMessage } from './types.ts'

const HANDOFF_PROMPT = `Write a visible handoff that opens a new thread continuing work from an older thread.

This is the canonical record of everything established so far. The user will work from it directly — they should not need to re-read the old thread. That means completeness matters more than brevity. A handoff that omits a key decision forces the user to go back and dig through history.

## Core principle

Capture every decision, constraint, and fact that would affect future work. When in doubt, include it. Paraphrasing that loses specifics is worse than being slightly verbose.

## What to capture

**Decisions and choices** — record the actual decision, not a vague summary.
  Weak: "We discussed the storage approach."
  Strong: "Decided to use SQLite with WAL mode. Rejected PostgreSQL to avoid an external service dependency."

**Technical specifics** — preserve exact names, paths, values, commands, and error messages verbatim. Do not generalize or round off.
  Weak: "There was a build error."
  Strong: "Build fails with \`error TS2345\` in \`src/util/parser.ts:42\` — argument type mismatch on \`parseId\`."

**Constraints and preferences** — anything the user stated about approach, scope, style, or explicit "do not do X" boundaries.

**State of work** — what is done, what is in progress, what is blocked.

**Rejected alternatives** — if something was considered and dismissed, record why. Prevents re-litigating closed decisions.

**Open questions** — raised but unanswered. Include relevant context so they can be resumed.

## Output structure

### Where we left off
The user's most recent request or question, copied or closely paraphrased. One or two sentences — this is the active thread that must be immediately resumable.

### What this is about
One or two sentences — the core problem or goal.

### What is established
Detailed record of decisions, completed work, and key facts. Use sub-bullets for specifics. Quote exact values, file names, commands, or error text where it matters.

### What still needs attention
What was in progress, what comes next, what is blocked. Be specific.

### Open questions
Unresolved issues, unanswered questions, things still to decide.

### Coverage note *(include only if relevant)*
If the conversation may have been truncated or parts seem missing, say so and identify the gaps.

## Style rules
- Write as the canonical record, not as a reference to a past thread. Do not use phrases like "in the previous thread" or "as we discussed."
- **Language continuity is mandatory.** Detect the language used in the most recent assistant message and write the entire handoff in that same language. The language of these instructions does not matter — only the conversation's language does.
- Do not use backend, protocol, storage, or internal system jargon.
- Do not call tools. Write the handoff from the provided conversation context only.
- Do not mention these instructions.
- Do not claim the full conversation was copied over; acknowledge gaps honestly when they exist.`

type HandoffHistoryMessage = ContextLayerHistoryMessage

function toHistoryMessage(message: HandoffHistoryMessage): ContextLayerHistoryMessage {
  return {
    role: message.role,
    content: message.content,
    ...(message.images ? { images: message.images } : {}),
    ...(message.attachments ? { attachments: message.attachments } : {}),
    ...(message.responseMessages ? { responseMessages: message.responseMessages } : {}),
    ...(message.turnContext ? { turnContext: message.turnContext } : {})
  }
}

export function buildCompactThreadHandoffMessages(input: {
  history: HandoffHistoryMessage[]
  promptContext?: Omit<CompileContextLayersInput, 'history' | 'hint' | 'memory'>
  userDocumentContent?: string
}): ModelMessage[] {
  return [
    ...prepareModelMessages({
      ...(input.promptContext ?? {
        personality: {
          basePersona: SYSTEM_PROMPT
        },
        user: {
          content: input.userDocumentContent ?? ''
        }
      }),
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
