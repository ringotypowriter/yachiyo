import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { MemoryService } from '../../services/memory/memoryService.ts'
import { writeUserDocument } from '../../runtime/user.ts'

const updateMemoryToolInputSchema = z.object({
  mode: z.enum(['profile', 'memory']),
  content: z.string().min(1)
})

type UpdateMemoryToolInput = z.infer<typeof updateMemoryToolInputSchema>

interface UpdateMemoryToolOutput {
  content: Array<{ type: 'text'; text: string }>
  error?: string
}

export interface UpdateMemoryDeps {
  memoryService: MemoryService
  /** Absolute path to the guest's workspace USER.md. */
  userDocumentPath: string
}

export function createTool(
  deps: UpdateMemoryDeps
): Tool<UpdateMemoryToolInput, UpdateMemoryToolOutput> {
  return tool({
    description: [
      'Save observations about the current user or conversation.',
      'mode "profile": Update the USER.md with durable understanding of this person (preferences, background, communication style).',
      'mode "memory": Save a fact or observation to long-term memory (works only when memory is configured).'
    ].join(' '),
    inputSchema: updateMemoryToolInputSchema,
    toModelOutput: ({ output }) =>
      output.error
        ? { type: 'error-text', value: output.error }
        : { type: 'content', value: output.content },
    execute: async (input) => {
      try {
        if (input.mode === 'profile') {
          await writeUserDocument({
            filePath: deps.userDocumentPath,
            content: input.content
          })
          return {
            content: [{ type: 'text', text: 'Profile updated.' }]
          }
        }

        if (!deps.memoryService.isConfigured()) {
          return {
            content: [{ type: 'text', text: 'Memory is not configured. Observation not saved.' }],
            error: 'Memory is not configured.'
          }
        }

        const result = await deps.memoryService.createMemory({
          topic: 'channel-observation',
          title: input.content.slice(0, 80),
          content: input.content,
          unitType: 'fact'
        })

        return {
          content: [
            {
              type: 'text',
              text:
                result.savedCount > 0
                  ? 'Memory saved.'
                  : 'Memory service accepted the request but saved 0 entries.'
            }
          ]
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'updateMemory failed.'
        return {
          content: [{ type: 'text', text: message }],
          error: message
        }
      }
    }
  })
}
