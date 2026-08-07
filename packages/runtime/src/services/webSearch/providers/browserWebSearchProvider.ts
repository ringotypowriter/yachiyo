import type { WebSearchFailureCode, WebSearchResultItem } from '@yachiyo/shared/protocol'
import { runWithBrowserRetries } from '../../browserRetry.ts'
import type { BrowserSearchPageLoadOptions, BrowserSearchSession } from '../browserSearchSession.ts'
import type { WebSearchProvider, WebSearchResult } from '../webSearchService.ts'

export interface RawBrowserSearchResult {
  href: string
  snippet: string
  title: string
}

export interface BrowserWebSearchProviderDefinition {
  buildRequest(input: { limit: number; query: string }): {
    options?: BrowserSearchPageLoadOptions
    url: string
  }
  challengeError: string
  challengePredicate: string
  extractionScript: string
  id: string
  name: string
  noResultsError: string
  normalizeResults(rawResults: RawBrowserSearchResult[], limit: number): WebSearchResultItem[]
  readyPredicate: string
}

function createFailure(input: {
  definition: BrowserWebSearchProviderDefinition
  error: string
  failureCode: WebSearchFailureCode
  query: string
  searchUrl: string
  finalUrl?: string
}): WebSearchResult {
  return {
    provider: input.definition.id,
    query: input.query,
    searchUrl: input.searchUrl,
    ...(input.finalUrl ? { finalUrl: input.finalUrl } : {}),
    results: [],
    failureCode: input.failureCode,
    error: input.error
  }
}

export function normalizeRawBrowserSearchResults(
  rawResults: RawBrowserSearchResult[],
  limit: number,
  normalizeUrl: (value: string) => string | undefined
): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = []
  const seenUrls = new Set<string>()

  for (const rawResult of rawResults) {
    const url = normalizeUrl(rawResult.href)
    const title = rawResult.title.trim()

    if (!url || !title || seenUrls.has(url)) {
      continue
    }

    seenUrls.add(url)
    results.push({
      title,
      url,
      ...(rawResult.snippet.trim() ? { snippet: rawResult.snippet.trim() } : {}),
      rank: results.length + 1
    })

    if (results.length >= limit) {
      break
    }
  }

  return results
}

export function createBrowserWebSearchProvider(input: {
  browserSession: BrowserSearchSession
  definition: BrowserWebSearchProviderDefinition
  loadTimeoutMs?: number
  retryAttempts?: number
  retryDelayMs?: number
}): WebSearchProvider {
  const loadTimeoutMs = input.loadTimeoutMs ?? 15_000
  const retryAttempts = input.retryAttempts ?? 3
  const retryDelayMs = input.retryDelayMs ?? 350
  const { definition } = input

  return {
    id: definition.id,
    async search({ limit, query, signal }) {
      const request = definition.buildRequest({ limit, query })

      return runWithBrowserRetries<WebSearchResult>({
        attempts: retryAttempts,
        delayMs: retryDelayMs,
        signal,
        shouldRetryResult: (result, attempt) =>
          attempt < retryAttempts &&
          (result.failureCode === 'load-failed' || result.failureCode === 'extraction-failed'),
        run: async () =>
          input.browserSession.withPage(async (page) => {
            try {
              await page.loadURL(request.url, request.options)
              await page.waitForFunction({
                predicate: definition.readyPredicate,
                timeoutMs: loadTimeoutMs,
                signal
              })
            } catch (error) {
              return createFailure({
                definition,
                error:
                  error instanceof Error
                    ? error.message
                    : `Failed to load ${definition.name} search results for "${query}".`,
                failureCode:
                  error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'load-failed',
                query,
                searchUrl: request.url,
                finalUrl: await page.getURL()
              })
            }

            let hasChallenge: boolean
            try {
              hasChallenge = await page.evaluate<boolean>(definition.challengePredicate)
            } catch (error) {
              return createFailure({
                definition,
                error:
                  error instanceof Error
                    ? error.message
                    : `Failed to inspect ${definition.name} search results for "${query}".`,
                failureCode: 'extraction-failed',
                query,
                searchUrl: request.url,
                finalUrl: await page.getURL()
              })
            }

            if (hasChallenge === true) {
              return createFailure({
                definition,
                error: definition.challengeError,
                failureCode: 'provider-failed',
                query,
                searchUrl: request.url,
                finalUrl: await page.getURL()
              })
            }

            let rawResults: RawBrowserSearchResult[]
            try {
              rawResults = await page.evaluate<RawBrowserSearchResult[]>(
                definition.extractionScript
              )
            } catch (error) {
              return createFailure({
                definition,
                error:
                  error instanceof Error
                    ? error.message
                    : `Failed to extract ${definition.name} search results for "${query}".`,
                failureCode: 'extraction-failed',
                query,
                searchUrl: request.url,
                finalUrl: await page.getURL()
              })
            }

            const results = definition.normalizeResults(rawResults, limit)
            if (results.length === 0) {
              return createFailure({
                definition,
                error: definition.noResultsError,
                failureCode: 'extraction-failed',
                query,
                searchUrl: request.url,
                finalUrl: await page.getURL()
              })
            }

            return {
              provider: definition.id,
              query,
              searchUrl: request.url,
              finalUrl: await page.getURL(),
              results
            }
          })
      })
    }
  }
}
