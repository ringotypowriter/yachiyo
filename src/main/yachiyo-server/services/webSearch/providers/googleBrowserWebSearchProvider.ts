import type {
  WebSearchFailureCode,
  WebSearchResultItem
} from '../../../../../shared/yachiyo/protocol.ts'
import type { BrowserSearchSession } from '../browserSearchSession.ts'
import type { WebSearchProvider, WebSearchResult } from '../webSearchService.ts'

const GOOGLE_SEARCH_URL = 'https://www.google.com/search'
const GOOGLE_HOST_PATTERN = /(^|\.)google\./iu
const GOOGLE_INTERNAL_PATHS = new Set([
  '/',
  '/search',
  '/url',
  '/imgres',
  '/aclk',
  '/preferences',
  '/setprefs',
  '/advanced_search'
])
const PAGE_READY_PREDICATE = `
  (() => {
    const readyState = document.readyState
    if (readyState !== 'interactive' && readyState !== 'complete') {
      return false
    }

    return Boolean(document.querySelector('a[href] h3'))
  })()
`
const EXTRACTION_SCRIPT = `
  (() => {
    const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim()
    const anchors = Array.from(document.querySelectorAll('a[href]'))
    const seen = new Set()
    const results = []

    for (const anchor of anchors) {
      const heading = anchor.querySelector('h3')
      if (!heading) {
        continue
      }

      const href = anchor.href
      const title = normalizeText(heading.textContent)

      if (!href || !title) {
        continue
      }

      const container = anchor.closest('div')
      const snippetCandidates = container
        ? Array.from(container.querySelectorAll('span, div')).map((node) => normalizeText(node.textContent))
        : []
      const snippet = snippetCandidates.find((value) => value && value !== title) || ''
      const key = href + '\\n' + title

      if (seen.has(key)) {
        continue
      }

      seen.add(key)
      results.push({
        href,
        snippet,
        title
      })
    }

    return results
  })()
`

interface RawGoogleSearchResult {
  href: string
  snippet: string
  title: string
}

function createFailure(input: {
  error: string
  failureCode: WebSearchFailureCode
  query: string
  searchUrl: string
  finalUrl?: string
}): WebSearchResult {
  return {
    provider: 'google-browser',
    query: input.query,
    searchUrl: input.searchUrl,
    ...(input.finalUrl ? { finalUrl: input.finalUrl } : {}),
    results: [],
    failureCode: input.failureCode,
    error: input.error
  }
}

function normalizeGoogleWrappedUrl(value: string): string | undefined {
  try {
    const url = new URL(value)

    if (!GOOGLE_HOST_PATTERN.test(url.hostname)) {
      return url.toString()
    }

    if (url.pathname === '/url') {
      const wrapped = url.searchParams.get('url') ?? url.searchParams.get('q')
      if (!wrapped) {
        return undefined
      }

      return new URL(wrapped).toString()
    }

    return url.toString()
  } catch {
    return undefined
  }
}

function isOrganicResultUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return false
    }

    if (!GOOGLE_HOST_PATTERN.test(url.hostname)) {
      return true
    }

    return !GOOGLE_INTERNAL_PATHS.has(url.pathname)
  } catch {
    return false
  }
}

export function normalizeGoogleOrganicResults(
  rawResults: RawGoogleSearchResult[],
  limit: number
): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = []
  const seenUrls = new Set<string>()

  for (const rawResult of rawResults) {
    const normalizedUrl = normalizeGoogleWrappedUrl(rawResult.href)
    if (!normalizedUrl || !isOrganicResultUrl(normalizedUrl) || seenUrls.has(normalizedUrl)) {
      continue
    }

    seenUrls.add(normalizedUrl)
    results.push({
      title: rawResult.title.trim(),
      url: normalizedUrl,
      ...(rawResult.snippet.trim() ? { snippet: rawResult.snippet.trim() } : {}),
      rank: results.length + 1
    })

    if (results.length >= limit) {
      break
    }
  }

  return results
}

export function createGoogleBrowserWebSearchProvider(input: {
  browserSession: BrowserSearchSession
  loadTimeoutMs?: number
}): WebSearchProvider {
  const loadTimeoutMs = input.loadTimeoutMs ?? 15_000

  return {
    id: 'google-browser',
    async search({ limit, query, signal }) {
      const searchUrl = new URL(GOOGLE_SEARCH_URL)
      searchUrl.searchParams.set('hl', 'en')
      searchUrl.searchParams.set('num', String(limit))
      searchUrl.searchParams.set('q', query)

      return input.browserSession.withPage(async (page) => {
        try {
          await page.loadURL(searchUrl.toString())
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
                : `Failed to load Google search results for "${query}".`,
            failureCode,
            query,
            searchUrl: searchUrl.toString(),
            finalUrl: page.getURL()
          })
        }

        let rawResults: RawGoogleSearchResult[] = []

        try {
          rawResults = await page.evaluate<RawGoogleSearchResult[]>(EXTRACTION_SCRIPT)
        } catch (error) {
          return createFailure({
            error:
              error instanceof Error
                ? error.message
                : `Failed to extract Google search results for "${query}".`,
            failureCode: 'extraction-failed',
            query,
            searchUrl: searchUrl.toString(),
            finalUrl: page.getURL()
          })
        }

        const results = normalizeGoogleOrganicResults(rawResults, limit)

        if (results.length === 0) {
          return createFailure({
            error: 'Google search returned no extractable organic results.',
            failureCode: 'extraction-failed',
            query,
            searchUrl: searchUrl.toString(),
            finalUrl: page.getURL()
          })
        }

        return {
          provider: 'google-browser',
          query,
          searchUrl: searchUrl.toString(),
          finalUrl: page.getURL(),
          results
        }
      })
    }
  }
}
