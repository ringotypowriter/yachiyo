import { tool, type Tool } from 'ai'
import { z } from 'zod'

import type { ThreadSearchResult } from '../../../../shared/yachiyo/protocol.ts'
import type { MemorySearchResult, MemoryService } from '../../services/memory/memoryService.ts'

const baseInputFields = {
  query: z.string().min(1).describe('Retrieval-oriented search query'),
  topic: z.string().optional().describe('Filter results to a specific topic key'),
  limit: z.number().int().min(1).max(10).optional().describe('Max results (default 5)')
}

const domainField = {
  domain: z
    .enum(['default', 'cross-thread'])
    .optional()
    .describe(
      'Search domain. "default" searches long-term memory. "cross-thread" searches message history across threads using full-text search with BM25 ranking.'
    )
}

// The handler always accepts domain (as optional) regardless of schema variant.
type SearchMemoryToolInput =
  z.infer<typeof baseInputFields.query> extends string
    ? {
        query: string
        topic?: string
        limit?: number
        domain?: 'default' | 'cross-thread'
      }
    : never

interface SearchMemoryToolOutput {
  content: Array<{ type: 'text'; text: string }>
  error?: string
}

export type CrossThreadSearchFn = (input: {
  query: string
  limit?: number
  includePrivate?: boolean
}) => ThreadSearchResult[]

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

function formatCrossThreadResult(result: ThreadSearchResult, index: number): string {
  const lines = [
    `${index + 1}. [${result.threadId}] ${result.threadTitle}`,
    `   updated: ${result.threadUpdatedAt}`,
    `   titleMatched: ${result.titleMatched}`
  ]

  for (const match of result.messageMatches) {
    lines.push(`   message [${match.messageId}]: ${match.snippet}`)
  }

  return lines.join('\n')
}

export interface SearchMemoryToolDeps {
  memoryService?: MemoryService
  crossThreadSearch?: CrossThreadSearchFn
}

const DESCRIPTION_MEMORY_ONLY =
  'Search long-term memory. Use to recall stored preferences, decisions, workflows, facts, and observations. Supports optional topic filtering.'

const DESCRIPTION_CROSS_THREAD_ONLY =
  'Search message history across threads using full-text BM25 ranking. Use to find past conversations, decisions, and context from previous threads.'

const DESCRIPTION_BOTH =
  'Search long-term memory or thread history. Use to recall stored preferences, decisions, workflows, facts, and observations. With domain "cross-thread", searches message content across all threads using full-text BM25 ranking.'

function buildDescription(hasMemory: boolean, hasCrossThread: boolean): string {
  if (hasMemory && hasCrossThread) return DESCRIPTION_BOTH
  if (hasCrossThread) return DESCRIPTION_CROSS_THREAD_ONLY
  return DESCRIPTION_MEMORY_ONLY
}

const schemaMemoryOnly = z.object(baseInputFields)
const schemaCrossThreadOnly = z.object({
  query: baseInputFields.query,
  limit: baseInputFields.limit
})
const schemaBoth = z.object({ ...baseInputFields, ...domainField })

export function createTool(
  deps: SearchMemoryToolDeps
): Tool<SearchMemoryToolInput, SearchMemoryToolOutput> {
  const hasMemory = deps.memoryService != null
  const hasCrossThread = deps.crossThreadSearch != null
  const inputSchema =
    hasMemory && hasCrossThread
      ? schemaBoth
      : hasCrossThread
        ? schemaCrossThreadOnly
        : schemaMemoryOnly

  return tool({
    description: buildDescription(hasMemory, hasCrossThread),
    inputSchema: inputSchema as z.ZodType<SearchMemoryToolInput>,
    toModelOutput: ({ output }) =>
      output.error
        ? { type: 'error-text', value: output.error }
        : { type: 'content', value: output.content },
    execute: async (input, options) => {
      try {
        // Determine domain: explicit from input, or inferred from available capabilities
        const explicitDomain = 'domain' in input ? input.domain : undefined
        const domain = explicitDomain ?? (hasMemory ? 'default' : 'cross-thread')

        if (domain === 'cross-thread' && deps.crossThreadSearch) {
          const results = deps.crossThreadSearch({
            query: input.query,
            limit: input.limit ?? 5
          })

          if (results.length === 0) {
            return {
              content: [{ type: 'text', text: 'No matching threads found.' }]
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: results
                  .map((result, index) => formatCrossThreadResult(result, index))
                  .join('\n\n')
              }
            ]
          }
        }

        if (!deps.memoryService) {
          return {
            content: [{ type: 'text', text: 'Long-term memory is not configured.' }]
          }
        }

        // Default domain: search long-term memory
        const results = await deps.memoryService.searchMemories({
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
