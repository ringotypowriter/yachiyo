import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { MemorySearchResult, MemoryService } from '../../services/memory/memoryService.ts'

const searchMemoryToolInputSchema = z.object({
  query: z.string().min(1).describe('Retrieval-oriented search query'),
  topic: z.string().optional().describe('Filter results to a specific topic key'),
  limit: z.number().int().min(1).max(10).optional().describe('Max results (default 5)')
})

type SearchMemoryToolInput = z.infer<typeof searchMemoryToolInputSchema>

interface SearchMemoryToolOutput {
  content: Array<{ type: 'text'; text: string }>
  error?: string
}

function formatMemoryResult(result: MemorySearchResult, index: number): string {
  const lines = [
    `${index + 1}. [${result.id}] ${result.title?.trim() || 'Untitled memory'}`,
    `   topic: ${result.labels?.find((label) => label.startsWith('topic:'))?.slice('topic:'.length) || 'unknown'}`,
    `   unitType: ${result.unitType ?? 'fact'}`,
    `   content: ${result.content.trim()}`
  ]

  if (typeof result.importance === 'number') {
    lines.push(`   importance: ${result.importance}`)
  }

  if (typeof result.score === 'number') {
    lines.push(`   score: ${result.score}`)
  }

  return lines.join('\n')
}

export function createTool(
  memoryService: MemoryService
): Tool<SearchMemoryToolInput, SearchMemoryToolOutput> {
  return tool({
    description:
      'Search long-term memory. Use to recall stored preferences, decisions, workflows, facts, and observations. Supports optional topic filtering.',
    inputSchema: searchMemoryToolInputSchema,
    toModelOutput: ({ output }) =>
      output.error
        ? { type: 'error-text', value: output.error }
        : { type: 'content', value: output.content },
    execute: async (input, options) => {
      try {
        const results = await memoryService.searchMemories({
          limit: input.limit,
          query: input.query,
          topic: input.topic,
          signal: options.abortSignal
        })

        if (results.length === 0) {
          return {
            content: [{ type: 'text', text: 'No matching long-term memories found.' }]
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
