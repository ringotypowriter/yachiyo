import { tool, type Tool } from 'ai'

import type { WebSearchToolCallDetails } from '../../../../shared/yachiyo/protocol.ts'
import type { WebSearchService } from '../../services/webSearch/webSearchService.ts'
import { normalizeSearchQuery } from '../../services/webSearch/normalizeSearchQuery.ts'
import {
  DEFAULT_WEB_SEARCH_LIMIT,
  type AgentToolContext,
  type WebSearchToolInput,
  type WebSearchToolOutput,
  textContent,
  toToolModelOutput,
  webSearchToolInputSchema
} from './shared.ts'

function buildWebSearchModelContent(details: WebSearchToolCallDetails): string {
  const lines = [
    `Provider: ${details.provider}`,
    `Query: ${details.query}`,
    ...(details.searchUrl ? [`Search URL: ${details.searchUrl}`] : []),
    ...(details.finalUrl ? [`Loaded URL: ${details.finalUrl}`] : [])
  ]

  if (details.results.length === 0) {
    lines.push('', 'No results.')
    return lines.join('\n')
  }

  for (const result of details.results) {
    lines.push(
      '',
      `${result.rank}. ${result.title}`,
      `URL: ${result.url}`,
      ...(result.snippet ? [`Snippet: ${result.snippet}`] : [])
    )
  }

  return lines.join('\n')
}

function createWebSearchResult(
  details: WebSearchToolCallDetails,
  error?: string
): WebSearchToolOutput {
  return {
    content: textContent(error ?? buildWebSearchModelContent(details)),
    details,
    ...(error ? { error } : {}),
    metadata: {}
  }
}

function createFailureDetails(input: {
  provider: string
  query: string
  failureCode: NonNullable<WebSearchToolCallDetails['failureCode']>
}): WebSearchToolCallDetails {
  return {
    provider: input.provider,
    query: input.query,
    results: [],
    resultCount: 0,
    failureCode: input.failureCode
  }
}

export const WEB_SEARCH_TOOL_DESCRIPTION =
  'Run a general web search and return normalized organic search results. Use it for broad discovery, current web lookups, or finding candidate sources. This is not a browser automation tool. ' +
  'When searching for time-sensitive information, you may use {currentYear} in the query; it will be replaced with the actual current year automatically.'

export function createTool(
  _context: AgentToolContext,
  dependencies: {
    webSearchService: WebSearchService
  }
): Tool<WebSearchToolInput, WebSearchToolOutput> {
  return tool({
    description: WEB_SEARCH_TOOL_DESCRIPTION,
    inputSchema: webSearchToolInputSchema,
    toModelOutput: ({ output }) => toToolModelOutput(output),
    execute: (input, options) =>
      runWebSearchTool(input, {
        webSearchService: dependencies.webSearchService,
        signal: options.abortSignal
      })
  })
}

export async function runWebSearchTool(
  input: WebSearchToolInput,
  dependencies: {
    signal?: AbortSignal
    webSearchService: WebSearchService
  }
): Promise<WebSearchToolOutput> {
  const query = normalizeSearchQuery(input.query.trim())

  if (!query) {
    return createWebSearchResult(
      createFailureDetails({
        provider: 'google-browser',
        query,
        failureCode: 'invalid-query'
      }),
      'query must not be empty.'
    )
  }

  const result = await dependencies.webSearchService.search({
    query,
    limit: input.limit ?? DEFAULT_WEB_SEARCH_LIMIT,
    signal: dependencies.signal
  })

  return createWebSearchResult(
    {
      provider: result.provider,
      query: result.query,
      ...(result.searchUrl ? { searchUrl: result.searchUrl } : {}),
      ...(result.finalUrl ? { finalUrl: result.finalUrl } : {}),
      results: result.results,
      resultCount: result.results.length,
      ...(result.failureCode ? { failureCode: result.failureCode } : {})
    },
    result.error
  )
}
