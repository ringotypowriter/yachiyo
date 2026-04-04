import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { MemoryService } from '../../services/memory/memoryService.ts'

const MEMORY_UNIT_TYPES = [
  'fact',
  'preference',
  'decision',
  'plan',
  'procedure',
  'learning',
  'context',
  'event'
] as const

const rememberToolInputSchema = z.object({
  title: z.string().min(3).max(80).describe('Short, stable title for this memory'),
  content: z
    .string()
    .min(20)
    .max(320)
    .describe('The fact, preference, or observation to remember (20-320 chars)'),
  topic: z
    .string()
    .min(3)
    .max(64)
    .optional()
    .describe('Canonical topic key (auto-derived from title if omitted)'),
  unitType: z
    .enum(MEMORY_UNIT_TYPES)
    .optional()
    .describe('Memory classification (defaults to fact)'),
  importance: z.number().min(0).max(1).optional().describe('Weight 0.0-1.0 (defaults to 0.5)')
})

type RememberToolInput = z.infer<typeof rememberToolInputSchema>

interface RememberToolOutput {
  content: Array<{ type: 'text'; text: string }>
  error?: string
}

export interface RememberToolDeps {
  memoryService: MemoryService
}

export function createTool(deps: RememberToolDeps): Tool<RememberToolInput, RememberToolOutput> {
  return tool({
    description:
      'Save a durable memory for the user. Use when the user explicitly asks you to remember something — a preference, decision, fact, workflow, or constraint. Memories must be stated as timeless observations (no "this time", "we discussed", pronouns). The title should be a short stable label; the content should be a self-contained statement (20-320 chars).',
    inputSchema: rememberToolInputSchema,
    toModelOutput: ({ output }) =>
      output.error
        ? { type: 'error-text', value: output.error }
        : { type: 'content', value: output.content },
    execute: async (input, options) => {
      try {
        const result = await deps.memoryService.validateAndCreateMemory(
          {
            title: input.title,
            content: input.content,
            topic: input.topic,
            unitType: input.unitType,
            importance: input.importance
          },
          options.abortSignal
        )

        if (result.rejected) {
          return {
            content: [{ type: 'text', text: `Memory rejected: ${result.rejected}` }],
            error: result.rejected
          }
        }

        if (result.savedCount === 0) {
          return {
            content: [
              { type: 'text', text: 'Memory service accepted the request but saved 0 entries.' }
            ],
            error: 'No entries saved.'
          }
        }

        return {
          content: [{ type: 'text', text: `Memory saved: "${input.title}"` }]
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'remember failed.'
        return {
          content: [{ type: 'text', text: message }],
          error: message
        }
      }
    }
  })
}
