import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { MemoryService } from '../../services/memory/memoryService.ts'
import { toToolModelOutput } from './shared.ts'

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
  key: z
    .string()
    .min(3)
    .max(80)
    .describe('Stable canonical identifier for this memory (snake_case, e.g. "database_choice")'),
  facts: z
    .record(z.string(), z.string())
    .describe(
      'Structured key-value facts about this memory. Use compact field names, e.g. { "preference": "dark mode", "scope": "all interfaces" }'
    ),
  subjects: z
    .array(z.string())
    .min(1)
    .max(8)
    .describe(
      '3-8 activation keywords that help future recall. Include domain terms, variants, and likely user phrasings.'
    ),
  unitType: z
    .enum(MEMORY_UNIT_TYPES)
    .optional()
    .describe('Memory classification (defaults to fact)'),
  importance: z.number().min(0).max(1).optional().describe('Weight 0.0-1.0 (defaults to 0.5)'),
  scope: z
    .union([z.literal('global'), z.literal('workspace'), z.literal('thread')])
    .optional()
    .describe(
      'Scope of applicability. global = everywhere, workspace = current project only, thread = this conversation only (defaults to global)'
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
}

export function createTool(deps: RememberToolDeps): Tool<RememberToolInput, RememberToolOutput> {
  return tool({
    description:
      'Save a durable memory for the user. Use when the user explicitly asks you to remember something — a preference, decision, fact, workflow, or constraint. Write structured facts (not a narrative), provide generous activation subjects for future recall, and use a stable key that will still make sense months from now.',
    inputSchema: rememberToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: async (input, options) => {
      try {
        const result = await deps.memoryService.validateAndCreateMemory(
          {
            key: input.key,
            facts: input.facts,
            subjects: input.subjects,
            unitType: input.unitType,
            importance: input.importance,
            scope: input.scope
          },
          options.abortSignal,
          {
            workspacePath: deps.workspacePath,
            threadId: deps.threadId
          }
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
          content: [{ type: 'text', text: `Memory saved: "${input.key}"` }]
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
