import type { BrowserSearchSession } from '../browserSearchSession.ts'
import type { WebSearchProvider } from '../webSearchService.ts'
import {
  createBrowserWebSearchProvider,
  normalizeRawBrowserSearchResults,
  type BrowserWebSearchProviderDefinition
} from './browserWebSearchProvider.ts'

const BRAVE_SEARCH_URL = 'https://search.brave.com/search'
const BRAVE_HOST_PATTERN = /(^|\.)search\.brave\.com$/iu
const BRAVE_RESULT_SELECTOR =
  '.snippet:not(.standalone):not(.ad) .result-content a[href], .snippet:not(.standalone):not(.ad) .search-snippet-title'
const BRAVE_CHALLENGE_CHECK = `(Boolean(
  document.querySelector('a[href*="/help/pow-captcha"], [data-testid*="captcha" i]')
) ||
  (!hasOrganicResult &&
    /why am i seeing this[?]|verify you are human/i.test(document.body?.innerText || '')))`
const PAGE_READY_PREDICATE = `
  (() => {
    const readyState = document.readyState
    if (readyState !== 'interactive' && readyState !== 'complete') return false

    const hasOrganicResult = Boolean(document.querySelector('${BRAVE_RESULT_SELECTOR}'))
    const hasChallenge = ${BRAVE_CHALLENGE_CHECK}
    return hasOrganicResult || hasChallenge
  })()
`
const CHALLENGE_PREDICATE = `
  (() => {
    const hasOrganicResult = Boolean(document.querySelector('${BRAVE_RESULT_SELECTOR}'))
    return ${BRAVE_CHALLENGE_CHECK}
  })()
`
const EXTRACTION_SCRIPT = `
  (() => {
    const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim()
    const results = []

    for (const container of document.querySelectorAll('.snippet')) {
      if (container.classList.contains('standalone') || container.classList.contains('ad')) continue

      const anchor = container.querySelector('.result-content a[href]')
      const title = normalizeText(container.querySelector('.search-snippet-title')?.textContent)
      const snippet = normalizeText(container.querySelector('.generic-snippet .content')?.textContent)
      const href = anchor?.href || ''
      if (href && title) results.push({ href, snippet, title })
    }

    return results
  })()
`

function normalizeBraveResultUrl(value: string): string | undefined {
  try {
    const url = new URL(value, BRAVE_SEARCH_URL)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return BRAVE_HOST_PATTERN.test(url.hostname) ? undefined : url.toString()
  } catch {
    return undefined
  }
}

const BRAVE_DEFINITION: BrowserWebSearchProviderDefinition = {
  id: 'brave-browser',
  name: 'Brave',
  buildRequest: ({ query }) => {
    const searchUrl = new URL(BRAVE_SEARCH_URL)
    searchUrl.searchParams.set('q', query)
    searchUrl.searchParams.set('source', 'web')
    return { url: searchUrl.toString() }
  },
  readyPredicate: PAGE_READY_PREDICATE,
  challengePredicate: CHALLENGE_PREDICATE,
  extractionScript: EXTRACTION_SCRIPT,
  challengeError: 'Brave blocked this search with a proof-of-work challenge.',
  noResultsError: 'Brave search returned no extractable organic results.',
  normalizeResults: (rawResults, limit) =>
    normalizeRawBrowserSearchResults(rawResults, limit, normalizeBraveResultUrl)
}

export function createBraveBrowserWebSearchProvider(input: {
  browserSession: BrowserSearchSession
  loadTimeoutMs?: number
  retryAttempts?: number
  retryDelayMs?: number
}): WebSearchProvider {
  return createBrowserWebSearchProvider({ ...input, definition: BRAVE_DEFINITION })
}
