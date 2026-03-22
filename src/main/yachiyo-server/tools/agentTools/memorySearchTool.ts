import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { MemorySearchResult, MemoryService } from '../../services/memory/memoryService.ts'

const memorySearchToolInputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().min(1).max(10).optional()
})

type MemorySearchToolInput = z.infer<typeof memorySearchToolInputSchema>

interface MemorySearchToolOutput {
  content: Array<{
    type: 'text'
    text: string
  }>
  error?: string
}

function formatMemoryResult(result: MemorySearchResult, index: number): string {
  const lines = [
    `${index + 1}. ${result.title?.trim() || 'Untitled memory'}`,
    `topic: ${result.labels?.find((label) => label.startsWith('topic:'))?.slice('topic:'.length) || 'unknown'}`,
    `unitType: ${result.unitType ?? 'fact'}`,
    `content: ${result.content.trim()}`
  ]

  if (typeof result.importance === 'number') {
    lines.push(`importance: ${result.importance}`)
  }

  if (typeof result.score === 'number') {
    lines.push(`score: ${result.score}`)
  }

  return lines.join('\n')
}

export function createTool(
  memoryService: MemoryService
): Tool<MemorySearchToolInput, MemorySearchToolOutput> {
  return tool({
    description:
      'Search long-term memory using a retrieval-oriented query. Use this for durable preferences, decisions, workflows, constraints, bugs, and project facts when memory is enabled.',
    inputSchema: memorySearchToolInputSchema,
    toModelOutput: ({ output }) =>
      output.error
        ? {
            type: 'error-text',
            value: output.error
          }
        : {
            type: 'content',
            value: output.content
          },
    execute: async (input, options) => {
      try {
        const results = await memoryService.searchMemories({
          limit: input.limit,
          query: input.query,
          signal: options.abortSignal
        })

        if (results.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No matching long-term memories found.'
              }
            ]
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: results.map((result, index) => formatMemoryResult(result, index)).join('\n\n')
            }
          ]
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : 'Memory search failed.'
            }
          ],
          error: error instanceof Error ? error.message : 'Memory search failed.'
        }
      }
    }
  })
}
