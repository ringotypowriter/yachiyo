import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserSearchSession } from '../browserSearchSession.ts'
import {
  createGoogleBrowserWebSearchProvider,
  normalizeGoogleOrganicResults
} from './googleBrowserWebSearchProvider.ts'

test('normalizeGoogleOrganicResults unwraps Google redirect URLs and filters internal noise', () => {
  const results = normalizeGoogleOrganicResults(
    [
      {
        href: 'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Farticle',
        title: 'Article',
        snippet: 'Snippet'
      },
      {
        href: 'https://www.google.com/search?q=test',
        title: 'Ignored internal result',
        snippet: ''
      },
      {
        href: 'https://developers.google.com/search/docs',
        title: 'Google Developers',
        snippet: 'Legitimate organic result'
      },
      {
        href: 'https://example.com/article',
        title: 'Duplicate',
        snippet: 'Ignored duplicate'
      }
    ],
    10
  )

  assert.deepEqual(results, [
    {
      rank: 1,
      title: 'Article',
      url: 'https://example.com/article',
      snippet: 'Snippet'
    },
    {
      rank: 2,
      title: 'Google Developers',
      url: 'https://developers.google.com/search/docs',
      snippet: 'Legitimate organic result'
    }
  ])
})

test('Google browser provider extracts normalized organic results from a browser-backed session', async () => {
  let disposed = false
  const session = new BrowserSearchSession({
    profilePath: '/tmp/yachiyo-web-search-profile',
    pageFactory: {
      async createPage() {
        return {
          async loadURL() {
            return undefined
          },
          async waitForFunction() {
            return undefined
          },
          async evaluate<TResult>() {
            return [
              {
                href: 'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Ffirst',
                title: 'First result',
                snippet: 'First snippet'
              },
              {
                href: 'https://example.com/second',
                title: 'Second result',
                snippet: ''
              }
            ] as TResult
          },
          getURL() {
            return 'https://www.google.com/search?q=yachiyo'
          }
        }
      },
      async disposePage() {
        disposed = true
      }
    }
  })

  const provider = createGoogleBrowserWebSearchProvider({
    browserSession: session,
    loadTimeoutMs: 100
  })

  const result = await provider.search({
    query: 'yachiyo',
    limit: 2
  })

  assert.equal(disposed, true)
  assert.equal(result.provider, 'google-browser')
  assert.equal(result.results.length, 2)
  assert.equal(result.results[0]?.url, 'https://example.com/first')
  assert.equal(result.results[1]?.rank, 2)
})

test('Google browser provider retries transient load failures before succeeding', async () => {
  let disposed = 0
  let attempts = 0

  const session = new BrowserSearchSession({
    profilePath: '/tmp/yachiyo-web-search-profile',
    pageFactory: {
      async createPage() {
        attempts += 1

        return {
          async loadURL() {
            if (attempts < 3) {
              throw new Error('ERR_CONNECTION_CLOSED')
            }
          },
          async waitForFunction() {
            return undefined
          },
          async evaluate<TResult>() {
            return [
              {
                href: 'https://example.com/recovered',
                title: 'Recovered result',
                snippet: 'Recovered snippet'
              }
            ] as TResult
          },
          getURL() {
            return 'https://www.google.com/search?q=yachiyo'
          }
        }
      },
      async disposePage() {
        disposed += 1
      }
    }
  })

  const provider = createGoogleBrowserWebSearchProvider({
    browserSession: session,
    loadTimeoutMs: 100,
    retryAttempts: 3,
    retryDelayMs: 0
  })

  const result = await provider.search({
    query: 'yachiyo',
    limit: 1
  })

  assert.equal(attempts, 3)
  assert.equal(disposed, 3)
  assert.equal(result.failureCode, undefined)
  assert.equal(result.results[0]?.url, 'https://example.com/recovered')
})

test('Google browser provider retries extraction failures before succeeding', async () => {
  let attempts = 0

  const session = new BrowserSearchSession({
    profilePath: '/tmp/yachiyo-web-search-profile',
    pageFactory: {
      async createPage() {
        return {
          async loadURL() {
            return undefined
          },
          async waitForFunction() {
            return undefined
          },
          async evaluate<TResult>() {
            attempts += 1
            if (attempts < 3) {
              return [] as TResult
            }

            return [
              {
                href: 'https://example.com/final',
                title: 'Final result',
                snippet: 'Final snippet'
              }
            ] as TResult
          },
          getURL() {
            return 'https://www.google.com/search?q=yachiyo'
          }
        }
      },
      async disposePage() {
        return undefined
      }
    }
  })

  const provider = createGoogleBrowserWebSearchProvider({
    browserSession: session,
    loadTimeoutMs: 100,
    retryAttempts: 3,
    retryDelayMs: 0
  })

  const result = await provider.search({
    query: 'yachiyo',
    limit: 1
  })

  assert.equal(attempts, 3)
  assert.equal(result.failureCode, undefined)
  assert.equal(result.results[0]?.title, 'Final result')
})
