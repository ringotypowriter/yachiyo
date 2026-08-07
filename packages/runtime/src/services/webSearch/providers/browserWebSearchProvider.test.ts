import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserSearchSession } from '../browserSearchSession.ts'
import {
  createBrowserWebSearchProvider,
  normalizeRawBrowserSearchResults,
  type BrowserWebSearchProviderDefinition
} from './browserWebSearchProvider.ts'

const definition: BrowserWebSearchProviderDefinition = {
  id: 'test-browser',
  name: 'Test',
  buildRequest: ({ query }) => ({ url: `https://search.example/?q=${encodeURIComponent(query)}` }),
  readyPredicate: 'true',
  challengePredicate: 'false',
  extractionScript: '[]',
  challengeError: 'Test blocked this search.',
  noResultsError: 'Test returned no results.',
  normalizeResults: (rawResults, limit) =>
    normalizeRawBrowserSearchResults(rawResults, limit, (url) => url)
}

test('browser provider retries transient page failures and disposes every page', async () => {
  let attempts = 0
  let disposed = 0
  const session = new BrowserSearchSession({
    profilePath: '/tmp/yachiyo-web-search-profile',
    pageFactory: {
      async createPage() {
        attempts += 1
        const attempt = attempts
        return {
          async loadURL() {
            if (attempt < 2) throw new Error('temporary load failure')
          },
          async waitForFunction() {
            return undefined
          },
          async evaluate<TResult>(script: string) {
            if (script === definition.challengePredicate) return false as TResult
            return [
              { href: 'https://example.com', title: ' Result ', snippet: ' Text ' }
            ] as TResult
          },
          async getURL() {
            return 'https://search.example/?q=test'
          }
        }
      },
      async disposePage() {
        disposed += 1
      }
    }
  })
  const provider = createBrowserWebSearchProvider({
    browserSession: session,
    definition,
    retryAttempts: 2,
    retryDelayMs: 0
  })

  const result = await provider.search({ query: 'test', limit: 5 })

  assert.equal(attempts, 2)
  assert.equal(disposed, 2)
  assert.deepEqual(result.results, [
    { rank: 1, title: 'Result', url: 'https://example.com', snippet: 'Text' }
  ])
})

test('browser provider returns provider-failed without retrying a challenge page', async () => {
  let attempts = 0
  const session = new BrowserSearchSession({
    profilePath: '/tmp/yachiyo-web-search-profile',
    pageFactory: {
      async createPage() {
        attempts += 1
        return {
          async loadURL() {
            return undefined
          },
          async waitForFunction() {
            return undefined
          },
          async evaluate<TResult>() {
            return true as TResult
          },
          async getURL() {
            return 'https://search.example/challenge'
          }
        }
      },
      async disposePage() {
        return undefined
      }
    }
  })
  const provider = createBrowserWebSearchProvider({
    browserSession: session,
    definition,
    retryAttempts: 3,
    retryDelayMs: 0
  })

  const result = await provider.search({ query: 'test', limit: 5 })

  assert.equal(attempts, 1)
  assert.equal(result.failureCode, 'provider-failed')
  assert.equal(result.error, 'Test blocked this search.')
})

test('normalizer filters invalid and duplicate URLs while enforcing the limit', () => {
  assert.deepEqual(
    normalizeRawBrowserSearchResults(
      [
        { href: 'https://example.com/one', title: ' One ', snippet: ' First ' },
        { href: 'https://example.com/one', title: 'Duplicate', snippet: '' },
        { href: 'javascript:void(0)', title: 'Invalid', snippet: '' },
        { href: 'https://example.com/two', title: ' Two ', snippet: '' }
      ],
      2,
      (url) => (url.startsWith('https://') ? url : undefined)
    ),
    [
      { rank: 1, title: 'One', url: 'https://example.com/one', snippet: 'First' },
      { rank: 2, title: 'Two', url: 'https://example.com/two' }
    ]
  )
})
