import type {
  SettingsConfig,
  WebSearchFailureCode,
  WebSearchProviderId,
  WebSearchResultItem
} from '../../../../shared/yachiyo/protocol.ts'
import { DEFAULT_WEB_SEARCH_PROVIDER } from '../../../../shared/yachiyo/protocol.ts'
import { normalizeSearchQuery } from './normalizeSearchQuery.ts'

export interface WebSearchRequest {
  limit?: number
  query: string
  signal?: AbortSignal
}

export interface WebSearchResult {
  provider: string
  query: string
  searchUrl?: string
  finalUrl?: string
  results: WebSearchResultItem[]
  failureCode?: WebSearchFailureCode
  error?: string
}

export interface WebSearchProvider {
  readonly id: WebSearchProviderId | string
  search(input: { limit: number; query: string; signal?: AbortSignal }): Promise<WebSearchResult>
}

export interface WebSearchService {
  search(input: WebSearchRequest): Promise<WebSearchResult>
}

const DEFAULT_WEB_SEARCH_LIMIT = 5

function createFailureResult(input: {
  error: string
  failureCode: WebSearchFailureCode
  provider: string
  query: string
}): WebSearchResult {
  return {
    provider: input.provider,
    query: input.query,
    results: [],
    failureCode: input.failureCode,
    error: input.error
  }
}

export function resolveWebSearchProviderId(config: SettingsConfig): WebSearchProviderId | string {
  return config.webSearch?.defaultProvider?.trim() || DEFAULT_WEB_SEARCH_PROVIDER
}

export function createWebSearchService(input: {
  providers: WebSearchProvider[]
  readConfig: () => SettingsConfig
}): WebSearchService {
  const providers = new Map(input.providers.map((provider) => [provider.id, provider]))

  return {
    async search(request) {
      const query = normalizeSearchQuery(request.query.trim())

      if (!query) {
        return createFailureResult({
          error: 'query must not be empty.',
          failureCode: 'invalid-query',
          provider: resolveWebSearchProviderId(input.readConfig()),
          query
        })
      }

      const providerId = resolveWebSearchProviderId(input.readConfig())
      const provider = providers.get(providerId)

      if (!provider) {
        return createFailureResult({
          error: `Unsupported web search provider: ${providerId}`,
          failureCode: 'unsupported-provider',
          provider: providerId,
          query
        })
      }

      try {
        const result = await provider.search({
          query,
          limit: request.limit ?? DEFAULT_WEB_SEARCH_LIMIT,
          signal: request.signal
        })

        return {
          ...result
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return createFailureResult({
            error: 'web search was aborted.',
            failureCode: 'aborted',
            provider: providerId,
            query
          })
        }

        return createFailureResult({
          error: error instanceof Error ? error.message : 'web search failed.',
          failureCode: 'provider-failed',
          provider: providerId,
          query
        })
      }
    }
  }
}
