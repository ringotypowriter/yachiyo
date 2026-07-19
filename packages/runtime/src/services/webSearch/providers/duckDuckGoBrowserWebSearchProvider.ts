import type { WebSearchFailureCode, WebSearchResultItem } from '@yachiyo/shared/protocol'
import { runWithBrowserRetries } from '../../browserRetry.ts'
import type { BrowserSearchSession } from '../browserSearchSession.ts'
import type { WebSearchProvider, WebSearchResult } from '../webSearchService.ts'

const DUCKDUCKGO_SEARCH_URL = 'https://html.duckduckgo.com/html/'
const DUCKDUCKGO_HOST_PATTERN = /(^|\.)duckduckgo\.com$/iu
const PAGE_READY_PREDICATE = `
  (() => {
    const readyState = document.readyState
    if (readyState !== 'interactive' && readyState !== 'complete') {
      return false
    }

    return Boolean(document.querySelector('.result:not(.result--ad) a.result__a[href]'))
  })()
`
const EXTRACTION_SCRIPT = `
  (() => {
    const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim()
    const containers = Array.from(document.querySelectorAll('.result:not(.result--ad)'))
    const results = []

    for (const container of containers) {
      const anchor = container.querySelector('a.result__a[href]')
      if (!anchor) {
        continue
      }

      const href = anchor.href
      const title = normalizeText(anchor.textContent)
      const snippet = normalizeText(container.querySelector('.result__snippet')?.textContent)

      if (!href || !title) {
        continue
      }

      results.push({ href, snippet, title })
    }

    return results
  })()
`

interface RawDuckDuckGoSearchResult {
  href: string
  snippet: string
  title: string
}

function createFailure(input: {
  error: string
  failureCode: WebSearchFailureCode
  query: string
  finalUrl?: string
}): WebSearchResult {
  return {
    provider: 'duckduckgo-browser',
    query: input.query,
    searchUrl: DUCKDUCKGO_SEARCH_URL,
    ...(input.finalUrl ? { finalUrl: input.finalUrl } : {}),
    results: [],
    failureCode: input.failureCode,
    error: input.error
  }
}

function normalizeHttpUrl(value: string, base?: string): string | undefined {
  try {
    const url = base ? new URL(value, base) : new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function normalizeDuckDuckGoUrl(value: string): string | undefined {
  try {
    const url = new URL(value, DUCKDUCKGO_SEARCH_URL)

    if (DUCKDUCKGO_HOST_PATTERN.test(url.hostname) && url.pathname === '/l/') {
      const wrapped = url.searchParams.get('uddg')
      return wrapped ? normalizeHttpUrl(wrapped) : undefined
    }

    return normalizeHttpUrl(url.toString())
  } catch {
    return undefined
  }
}

export function normalizeDuckDuckGoOrganicResults(
  rawResults: RawDuckDuckGoSearchResult[],
  limit: number
): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = []
  const seenUrls = new Set<string>()

  for (const rawResult of rawResults) {
    const url = normalizeDuckDuckGoUrl(rawResult.href)
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

export function createDuckDuckGoBrowserWebSearchProvider(input: {
  browserSession: BrowserSearchSession
  loadTimeoutMs?: number
  retryAttempts?: number
  retryDelayMs?: number
}): WebSearchProvider {
  const loadTimeoutMs = input.loadTimeoutMs ?? 15_000
  const retryAttempts = input.retryAttempts ?? 3
  const retryDelayMs = input.retryDelayMs ?? 350

  return {
    id: 'duckduckgo-browser',
    async search({ limit, query, signal }) {
      const body = new URLSearchParams({ q: query, kl: 'us-en' }).toString()

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
              await page.loadURL(DUCKDUCKGO_SEARCH_URL, {
                post: {
                  body,
                  contentType: 'application/x-www-form-urlencoded'
                }
              })
              await page.waitForFunction({
                predicate: PAGE_READY_PREDICATE,
                timeoutMs: loadTimeoutMs,
                signal
              })
            } catch (error) {
              const failureCode =
                error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'load-failed'
              return createFailure({
                error:
                  error instanceof Error
                    ? error.message
                    : `Failed to load DuckDuckGo search results for "${query}".`,
                failureCode,
                query,
                finalUrl: await page.getURL()
              })
            }

            let rawResults: RawDuckDuckGoSearchResult[]

            try {
              rawResults = await page.evaluate<RawDuckDuckGoSearchResult[]>(EXTRACTION_SCRIPT)
            } catch (error) {
              return createFailure({
                error:
                  error instanceof Error
                    ? error.message
                    : `Failed to extract DuckDuckGo search results for "${query}".`,
                failureCode: 'extraction-failed',
                query,
                finalUrl: await page.getURL()
              })
            }

            const results = normalizeDuckDuckGoOrganicResults(rawResults, limit)

            if (results.length === 0) {
              return createFailure({
                error: 'DuckDuckGo search returned no extractable organic results.',
                failureCode: 'extraction-failed',
                query,
                finalUrl: await page.getURL()
              })
            }

            return {
              provider: 'duckduckgo-browser',
              query,
              searchUrl: DUCKDUCKGO_SEARCH_URL,
              finalUrl: await page.getURL(),
              results
            }
          })
      })
    }
  }
}
