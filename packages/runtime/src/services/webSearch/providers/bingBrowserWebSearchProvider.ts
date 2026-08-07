import type { BrowserSearchSession } from '../browserSearchSession.ts'
import type { WebSearchProvider } from '../webSearchService.ts'
import {
  createBrowserWebSearchProvider,
  normalizeRawBrowserSearchResults,
  type BrowserWebSearchProviderDefinition
} from './browserWebSearchProvider.ts'

const BING_SEARCH_URL = 'https://www.bing.com/search'
const BING_HOST_PATTERN = /(^|\.)bing\.com$/iu
const BING_RESULT_SELECTOR = '.b_algo h2 a[href]'
const BING_CHALLENGE_CHECK = `(Boolean(
  document.querySelector('#b_captcha, [id*="captcha" i], form[action*="captcha" i]')
) ||
  (!hasOrganicResult &&
    /verify that you are not a robot|unusual traffic/i.test(document.body?.innerText || '')))`
const PAGE_READY_PREDICATE = `
  (() => {
    const readyState = document.readyState
    if (readyState !== 'interactive' && readyState !== 'complete') return false

    const hasOrganicResult = Boolean(document.querySelector('${BING_RESULT_SELECTOR}'))
    const hasChallenge = ${BING_CHALLENGE_CHECK}
    return hasOrganicResult || hasChallenge
  })()
`
const CHALLENGE_PREDICATE = `
  (() => {
    const hasOrganicResult = Boolean(document.querySelector('${BING_RESULT_SELECTOR}'))
    return ${BING_CHALLENGE_CHECK}
  })()
`
const EXTRACTION_SCRIPT = `
  (() => {
    const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim()
    return Array.from(document.querySelectorAll('.b_algo')).flatMap((container) => {
      const anchor = container.querySelector('h2 a[href]')
      if (!anchor) return []

      const href = anchor.href
      const title = normalizeText(anchor.textContent)
      const snippet = normalizeText(container.querySelector('.b_caption p')?.textContent)
      return href && title ? [{ href, snippet, title }] : []
    })
  })()
`

function decodeBingRedirectTarget(value: string): string | undefined {
  try {
    const encoded = value.startsWith('a1') ? value.slice(2) : value
    const decoded = Buffer.from(encoded, 'base64url').toString('utf8')
    return /^https?:\/\//iu.test(decoded) ? decoded : undefined
  } catch {
    return undefined
  }
}

function normalizeBingResultUrl(value: string): string | undefined {
  try {
    const url = new URL(value, BING_SEARCH_URL)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined

    if (BING_HOST_PATTERN.test(url.hostname) && url.pathname === '/ck/a') {
      const wrapped = url.searchParams.get('u')
      if (!wrapped) return undefined
      return normalizeBingResultUrl(decodeBingRedirectTarget(wrapped) ?? wrapped)
    }

    return BING_HOST_PATTERN.test(url.hostname) ? undefined : url.toString()
  } catch {
    return undefined
  }
}

const BING_DEFINITION: BrowserWebSearchProviderDefinition = {
  id: 'bing-browser',
  name: 'Bing',
  buildRequest: ({ query }) => {
    const searchUrl = new URL(BING_SEARCH_URL)
    searchUrl.searchParams.set('q', query)
    return { url: searchUrl.toString() }
  },
  readyPredicate: PAGE_READY_PREDICATE,
  challengePredicate: CHALLENGE_PREDICATE,
  extractionScript: EXTRACTION_SCRIPT,
  challengeError: 'Bing blocked this search with a bot challenge.',
  noResultsError: 'Bing search returned no extractable organic results.',
  normalizeResults: (rawResults, limit) =>
    normalizeRawBrowserSearchResults(rawResults, limit, normalizeBingResultUrl)
}

export function createBingBrowserWebSearchProvider(input: {
  browserSession: BrowserSearchSession
  loadTimeoutMs?: number
  retryAttempts?: number
  retryDelayMs?: number
}): WebSearchProvider {
  return createBrowserWebSearchProvider({ ...input, definition: BING_DEFINITION })
}
