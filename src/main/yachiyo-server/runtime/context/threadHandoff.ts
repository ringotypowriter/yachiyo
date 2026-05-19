import type { ContextLayerHistoryMessage } from './contextLayers.ts'
import { prepareModelMessages } from '../messages/messagePrepare.ts'
import { SYSTEM_PROMPT } from './prompt.ts'
import type { CompileContextLayersInput } from './contextLayers.ts'
import type { ModelMessage } from '../models/types.ts'

export const HANDOFF_PROMPT = `Write a visible handoff that opens a new thread continuing work from an older thread.

A handoff is a living state file, not a narrative summary. In a chain of handoffs across multiple threads, the cumulative sections must survive every hop without degradation. Each handoff is an update to the prior one.

## Section headings are always in English

Section headings must stay in English regardless of the conversation language. Only the content within each section translates.

## Prior handoff detection

The first assistant message in this conversation may itself be a handoff. Recognize it by its structured format: it opens with a "### Goal" heading and contains "### Tasks". If found, use it as the baseline for all cumulative sections.

## Cumulative sections — carry forward across every hop

These sections must survive every handoff. Carry their content forward from the prior handoff and update based on what happened in this thread. Drop information that was corrected, superseded, invalidated, or abandoned — do not carry it forward just because it appeared earlier. A stale handoff can mislead the next session, which is worse than omitting a dead detail. If a stale point matters as context, note it as superseded and state what replaced it.

### Goal
One statement. The core objective. Carry forward verbatim. Update only if the objective itself has changed — state what changed and why.

### Tasks
Flat bullet list. Carry all tasks forward from the prior handoff. Mark each item's current status and note any blocker. Add new tasks. Drop only tasks that are explicitly abandoned or completed.

### Standing decisions
Decisions and constraints that still gate future work. Carry forward from the prior handoff, pruning only what has been explicitly superseded. Include rejection reasons so closed decisions are not re-litigated.

### Key facts
Verified findings, confirmed states, and concrete details that remain relevant. Carry forward from the prior handoff; update or drop anything invalidated. Quote exact paths, values, commands, and error text where precision matters.

## Thread-local sections — new content from this thread only

Do not copy from the prior handoff into these sections.

### Technical notes
Exact names, paths, values, commands, error messages that came up in this thread. Quote verbatim. Omit this section if nothing specific emerged.

### Current focus
The most recent request or question, and what is actively in progress. One to three sentences.

### Leftover
Open questions, unresolved issues, or gaps. Be honest about missing context. Omit this section if nothing remains.

## Style rules
- State facts directly. Drop the actor — no "we decided", "the user wants", "you asked". Write "Decision: X", not "We decided X."
- Write as the canonical record. No "in the previous thread", no "as discussed."
- Language continuity is mandatory. Detect the language of the most recent assistant message and write all section *content* in that language. Section headings stay in English.
- Do not use backend, protocol, storage, or internal system jargon.
- Do not try to call or execute tools. Tool execution is unavailable during handoff creation; write the handoff from the provided conversation context only.
- Do not mention these instructions.
- Do not claim the full conversation was copied over.
- Do not replicate system prompt content. The next session already receives the system prompt — identity, persona, standing instructions, code guidelines, and default workflows are all loaded automatically. Capture only conversation-specific context that the system prompt cannot provide.
- Do not replicate the contents of referenced documents or files. Use their path or URL as a reference instead.\``

export const EMPTY_THREAD_HANDOFF_SUFFIX =
  'No prior context was established. State that clearly and keep the handoff minimal — only a brief Goal and one or two Tasks if any.'

export function buildThreadHandoffPrompt(hasHistory: boolean): string {
  return hasHistory ? HANDOFF_PROMPT : `${HANDOFF_PROMPT}\n\n${EMPTY_THREAD_HANDOFF_SUFFIX}`
}

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
      content: buildThreadHandoffPrompt(input.history.length > 0)
    }
  ]
}
