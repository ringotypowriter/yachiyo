import type { WebSearchResultItem } from '@yachiyo/shared/protocol'
import type { BrowserSearchSession } from '../browserSearchSession.ts'
import type { WebSearchProvider } from '../webSearchService.ts'
import {
  createBrowserWebSearchProvider,
  normalizeRawBrowserSearchResults,
  type BrowserWebSearchProviderDefinition,
  type RawBrowserSearchResult
} from './browserWebSearchProvider.ts'

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
const GOOGLE_ORGANIC_RESULT_SELECTOR = 'a[href] h3'
const GOOGLE_CHALLENGE_CHECK = `(Boolean(
  document.querySelector('form[action*="/sorry/"], #recaptcha, .g-recaptcha')
) ||
  (!hasOrganicResult &&
    /unusual traffic|verify you are human/i.test(document.body?.innerText || '')))`
const PAGE_READY_PREDICATE = `
  (() => {
    const readyState = document.readyState
    if (readyState !== 'interactive' && readyState !== 'complete') {
      return false
    }

    const hasOrganicResult = Boolean(
      document.querySelector('${GOOGLE_ORGANIC_RESULT_SELECTOR}')
    )
    const hasBotChallenge = ${GOOGLE_CHALLENGE_CHECK}
    return hasOrganicResult || hasBotChallenge
  })()
`
const BOT_CHALLENGE_PREDICATE = `
  (() => {
    const hasOrganicResult = Boolean(
      document.querySelector('${GOOGLE_ORGANIC_RESULT_SELECTOR}')
    )
    return ${GOOGLE_CHALLENGE_CHECK}
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
      if (!heading) continue

      const href = anchor.href
      const title = normalizeText(heading.textContent)
      if (!href || !title) continue

      const container = anchor.closest('div')
      const snippetCandidates = container
        ? Array.from(container.querySelectorAll('span, div')).map((node) => normalizeText(node.textContent))
        : []
      const snippet = snippetCandidates.find((value) => value && value !== title) || ''
      const key = href + '\\n' + title
      if (seen.has(key)) continue

      seen.add(key)
      results.push({ href, snippet, title })
    }

    return results
  })()
`

function normalizeGoogleWrappedUrl(value: string): string | undefined {
  try {
    const url = new URL(value)

    if (!GOOGLE_HOST_PATTERN.test(url.hostname)) {
      return url.toString()
    }

    if (url.pathname === '/url') {
      const wrapped = url.searchParams.get('url') ?? url.searchParams.get('q')
      return wrapped ? new URL(wrapped).toString() : undefined
    }

    return url.toString()
  } catch {
    return undefined
  }
}

function isOrganicResultUrl(value: string): boolean {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return !GOOGLE_HOST_PATTERN.test(url.hostname) || !GOOGLE_INTERNAL_PATHS.has(url.pathname)
  } catch {
    return false
  }
}

export function normalizeGoogleOrganicResults(
  rawResults: RawBrowserSearchResult[],
  limit: number
): WebSearchResultItem[] {
  return normalizeRawBrowserSearchResults(rawResults, limit, (value) => {
    const normalizedUrl = normalizeGoogleWrappedUrl(value)
    return normalizedUrl && isOrganicResultUrl(normalizedUrl) ? normalizedUrl : undefined
  })
}

const GOOGLE_DEFINITION: BrowserWebSearchProviderDefinition = {
  id: 'google-browser',
  name: 'Google',
  buildRequest: ({ limit, query }) => {
    const searchUrl = new URL(GOOGLE_SEARCH_URL)
    searchUrl.searchParams.set('hl', 'en')
    searchUrl.searchParams.set('num', String(limit))
    searchUrl.searchParams.set('q', query)
    return { url: searchUrl.toString() }
  },
  readyPredicate: PAGE_READY_PREDICATE,
  challengePredicate: BOT_CHALLENGE_PREDICATE,
  extractionScript: EXTRACTION_SCRIPT,
  challengeError: 'Google blocked this search with a bot challenge.',
  noResultsError: 'Google search returned no extractable organic results.',
  normalizeResults: normalizeGoogleOrganicResults
}

export function createGoogleBrowserWebSearchProvider(input: {
  browserSession: BrowserSearchSession
  loadTimeoutMs?: number
  retryAttempts?: number
  retryDelayMs?: number
}): WebSearchProvider {
  return createBrowserWebSearchProvider({ ...input, definition: GOOGLE_DEFINITION })
}
