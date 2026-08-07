import type { WebSearchResultItem } from '@yachiyo/shared/protocol'
import type { BrowserSearchSession } from '../browserSearchSession.ts'
import type { WebSearchProvider } from '../webSearchService.ts'
import {
  createBrowserWebSearchProvider,
  normalizeRawBrowserSearchResults,
  type BrowserWebSearchProviderDefinition,
  type RawBrowserSearchResult
} from './browserWebSearchProvider.ts'

const DUCKDUCKGO_SEARCH_URL = 'https://html.duckduckgo.com/html/'
const DUCKDUCKGO_HOST_PATTERN = /(^|\.)duckduckgo\.com$/iu
const DUCKDUCKGO_BOT_CHALLENGE_TEXT = 'bots use DuckDuckGo too'
const DUCKDUCKGO_ORGANIC_RESULT_SELECTOR = '.result:not(.result--ad) a.result__a[href]'
const DUCKDUCKGO_BOT_CHALLENGE_SELECTOR = '#challenge-form, [data-testid="anomaly-modal"]'
const BOT_CHALLENGE_CHECK = `(Boolean(
  document.querySelector('${DUCKDUCKGO_BOT_CHALLENGE_SELECTOR}')
) ||
  (!hasOrganicResult &&
    (document.body?.innerText || '').includes('${DUCKDUCKGO_BOT_CHALLENGE_TEXT}')))`
const PAGE_READY_PREDICATE = `
  (() => {
    const readyState = document.readyState
    if (readyState !== 'interactive' && readyState !== 'complete') return false

    const hasOrganicResult = Boolean(
      document.querySelector('${DUCKDUCKGO_ORGANIC_RESULT_SELECTOR}')
    )
    const hasBotChallenge = ${BOT_CHALLENGE_CHECK}
    return hasOrganicResult || hasBotChallenge
  })()
`
const BOT_CHALLENGE_PREDICATE = `
  (() => {
    const hasOrganicResult = Boolean(
      document.querySelector('${DUCKDUCKGO_ORGANIC_RESULT_SELECTOR}')
    )
    return ${BOT_CHALLENGE_CHECK}
  })()
`
const EXTRACTION_SCRIPT = `
  (() => {
    const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim()
    const containers = Array.from(document.querySelectorAll('.result:not(.result--ad)'))
    const results = []

    for (const container of containers) {
      const anchor = container.querySelector('a.result__a[href]')
      if (!anchor) continue

      const href = anchor.href
      const title = normalizeText(anchor.textContent)
      const snippet = normalizeText(container.querySelector('.result__snippet')?.textContent)
      if (href && title) results.push({ href, snippet, title })
    }

    return results
  })()
`

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
  rawResults: RawBrowserSearchResult[],
  limit: number
): WebSearchResultItem[] {
  return normalizeRawBrowserSearchResults(rawResults, limit, normalizeDuckDuckGoUrl)
}

const DUCKDUCKGO_DEFINITION: BrowserWebSearchProviderDefinition = {
  id: 'duckduckgo-browser',
  name: 'DuckDuckGo',
  buildRequest: ({ query }) => ({
    url: DUCKDUCKGO_SEARCH_URL,
    options: {
      post: {
        body: new URLSearchParams({ q: query, kl: 'us-en' }).toString(),
        contentType: 'application/x-www-form-urlencoded'
      }
    }
  }),
  readyPredicate: PAGE_READY_PREDICATE,
  challengePredicate: BOT_CHALLENGE_PREDICATE,
  extractionScript: EXTRACTION_SCRIPT,
  challengeError: 'DuckDuckGo blocked this search with a bot challenge.',
  noResultsError: 'DuckDuckGo search returned no extractable organic results.',
  normalizeResults: normalizeDuckDuckGoOrganicResults
}

export function createDuckDuckGoBrowserWebSearchProvider(input: {
  browserSession: BrowserSearchSession
  loadTimeoutMs?: number
  retryAttempts?: number
  retryDelayMs?: number
}): WebSearchProvider {
  return createBrowserWebSearchProvider({ ...input, definition: DUCKDUCKGO_DEFINITION })
}
