import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { MemoryService } from '../../services/memory/memoryService.ts'
import { noteSourceEvidence } from '../../services/memory/memoryService/notes.ts'
import type { YachiyoStorage } from '../../storage/storage.ts'
import { toToolModelOutput } from './shared.ts'

const rememberToolInputSchema = z.object({
  note: z
    .string()
    .min(1)
    .max(8000)
    .optional()
    .describe(
      'A note in your own words: what is worth finding again, why it matters, and any conditions or uncertainty.'
    ),
  id: z
    .string()
    .optional()
    .describe(
      'Existing note id from querySource, for revising or deleting that note. Omit to create.'
    ),
  sources: z
    .array(z.string())
    .max(12)
    .optional()
    .describe(
      'Conversation source references from querySource. Current message and invocation are linked automatically.'
    ),
  action: z
    .enum(['save', 'delete'])
    .optional()
    .describe(
      'Save (default) creates or revises a note. Delete requires an existing id and removes only the note.'
    )
})

type RememberToolInput = z.infer<typeof rememberToolInputSchema>

interface RememberToolOutput {
  content: Array<{ type: 'text'; text: string }>
  error?: string
}

export interface RememberToolDeps {
  memoryService: MemoryService
  workspacePath?: string
  threadId?: string
  messageId?: string
  storage?: YachiyoStorage
}

export function createTool(deps: RememberToolDeps): Tool<RememberToolInput, RememberToolOutput> {
  return tool({
    description:
      'Keep a source-linked note that helps you return to a past conversation. Write when the user asks you to remember, or when a meaningful decision, correction, or understanding is worth carrying into later conversations. Notes are your revisable interpretation, not an authoritative replacement for original dialogue. Preserve conditions and distinguish proposals from completed actions. Use source references for historical claims; current-message links are navigation anchors, not proof of every statement. Ordinary progress belongs in the conversation, not in a new note every turn. Revise a known note by id when your understanding changes; delete only the note, never its source conversation.',
    inputSchema: rememberToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: async (input, options) => {
      try {
        if (input.action === 'delete' && (input.note || input.sources?.length)) {
          throw new Error('Deleting a note takes only its id and action.')
        }
        const evidence = noteSourceEvidence(input.sources ?? [])
        for (const source of evidence) {
          if (!deps.storage) throw new Error('Source validation requires local source storage.')
          const thread = source.threadId ? deps.storage.getThread(source.threadId) : undefined
          const message = source.messageId ? deps.storage.getMessage(source.messageId) : undefined
          if (
            !thread ||
            thread.privacyMode ||
            (source.messageId && (!message || message.hidden || message.threadId !== thread.id))
          ) {
            throw new Error(
              'Source not found or unavailable. Use a visible conversation reference from querySource.'
            )
          }
        }
        const result = await deps.memoryService.validateAndCreateMemory(
          input,
          options.abortSignal,
          {
            workspacePath: deps.workspacePath,
            threadId: deps.threadId,
            messageId: deps.messageId,
            toolCallId: options.toolCallId
          }
        )
        if (result.rejected) throw new Error(result.rejected)
        if (!result.deleted && result.savedCount === 0) throw new Error('No note was saved.')
        return { content: [{ type: 'text', text: JSON.stringify(result) }] }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'remember failed.'
        return { content: [{ type: 'text', text: message }], error: message }
      }
    }
  })
}
