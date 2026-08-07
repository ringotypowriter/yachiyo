import type { WebSearchFailureCode, WebSearchResultItem } from '@yachiyo/shared/protocol'
import { normalizeSearchQuery } from './normalizeSearchQuery.ts'
import {
  createWebSearchProviderSelector,
  type WebSearchProviderRegistration
} from './webSearchProviderSelector.ts'

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
  readonly id: string
  isAvailable?(): boolean
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

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function createWebSearchService(input: {
  now?: () => number
  providers: WebSearchProviderRegistration[]
}): WebSearchService {
  const now = input.now ?? Date.now
  const selector = createWebSearchProviderSelector({ providers: input.providers, now })

  return {
    async search(request) {
      const query = normalizeSearchQuery(request.query.trim())

      if (!query) {
        return createFailureResult({
          error: 'query must not be empty.',
          failureCode: 'invalid-query',
          provider: 'auto',
          query
        })
      }

      const attemptedProviderIds = new Set<string>()
      let lastFailure: WebSearchResult | undefined

      while (true) {
        const registration = selector.select(attemptedProviderIds)
        if (!registration) {
          if (lastFailure) {
            return {
              ...lastFailure,
              error: `${lastFailure.error ?? 'Web search failed.'} All available web search providers failed.`
            }
          }

          return createFailureResult({
            error: 'No web search providers are available.',
            failureCode: 'unsupported-provider',
            provider: 'auto',
            query
          })
        }

        const { provider } = registration
        attemptedProviderIds.add(provider.id)
        selector.begin(provider.id)
        const startedAt = now()
        let result: WebSearchResult
        let failureCode: WebSearchFailureCode | undefined = 'provider-failed'

        try {
          result = await provider.search({
            query,
            limit: request.limit ?? DEFAULT_WEB_SEARCH_LIMIT,
            signal: request.signal
          })
          failureCode = result.failureCode
        } catch (error) {
          result = createFailureResult({
            error: isAbortError(error)
              ? 'web search was aborted.'
              : error instanceof Error
                ? error.message
                : 'web search failed.',
            failureCode: isAbortError(error) ? 'aborted' : 'provider-failed',
            provider: provider.id,
            query
          })
          failureCode = result.failureCode
        } finally {
          selector.complete(provider.id, Math.max(0, now() - startedAt), failureCode)
        }

        if (!result.failureCode || result.failureCode === 'aborted') {
          return result
        }

        lastFailure = result
      }
    }
  }
}
