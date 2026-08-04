import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserSearchSession } from '../browserSearchSession.ts'
import { createDuckDuckGoBrowserWebSearchProvider } from './duckDuckGoBrowserWebSearchProvider.ts'

test('DuckDuckGo browser provider posts the query and returns normalized organic results', async () => {
  let disposed = false
  let loaded:
    | {
        options?: {
          post: {
            body: string
            contentType: string
          }
        }
        url: string
      }
    | undefined

  const session = new BrowserSearchSession({
    profilePath: '/tmp/yachiyo-web-search-profile',
    pageFactory: {
      async createPage() {
        return {
          async loadURL(url, options) {
            loaded = { url, options }
          },
          async waitForFunction() {
            return undefined
          },
          async evaluate<TResult>() {
            return [
              {
                href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ffirst%3Ffrom%3Dddg',
                title: ' First result ',
                snippet: ' First snippet '
              },
              {
                href: 'https://example.com/first?from=ddg',
                title: 'Duplicate result',
                snippet: 'Ignored duplicate'
              },
              {
                href: 'https://example.org/second',
                title: 'Second result',
                snippet: ''
              }
            ] as TResult
          },
          async getURL() {
            return 'https://html.duckduckgo.com/html/'
          }
        }
      },
      async disposePage() {
        disposed = true
      }
    }
  })

  const provider = createDuckDuckGoBrowserWebSearchProvider({
    browserSession: session,
    loadTimeoutMs: 100
  })

  const result = await provider.search({
    query: 'yachiyo electron',
    limit: 2
  })

  assert.deepEqual(loaded, {
    url: 'https://html.duckduckgo.com/html/',
    options: {
      post: {
        body: 'q=yachiyo+electron&kl=us-en',
        contentType: 'application/x-www-form-urlencoded'
      }
    }
  })
  assert.equal(disposed, true)
  assert.deepEqual(result, {
    provider: 'duckduckgo-browser',
    query: 'yachiyo electron',
    searchUrl: 'https://html.duckduckgo.com/html/',
    finalUrl: 'https://html.duckduckgo.com/html/',
    results: [
      {
        rank: 1,
        title: 'First result',
        url: 'https://example.com/first?from=ddg',
        snippet: 'First snippet'
      },
      {
        rank: 2,
        title: 'Second result',
        url: 'https://example.org/second'
      }
    ]
  })
})

test('DuckDuckGo browser provider stops immediately on a bot challenge', async () => {
  let attempts = 0
  let disposed = 0
  const session = new BrowserSearchSession({
    profilePath: '/tmp/yachiyo-web-search-profile',
    pageFactory: {
      async createPage() {
        attempts += 1
        return {
          async loadURL() {
            return undefined
          },
          async waitForFunction({ predicate }) {
            assert.match(predicate, /bots use DuckDuckGo too/i)
          },
          async evaluate<TResult>(script: string) {
            return script.includes('bots use DuckDuckGo too') as TResult
          },
          async getURL() {
            return 'https://html.duckduckgo.com/html/'
          }
        }
      },
      async disposePage() {
        disposed += 1
      }
    }
  })
  const provider = createDuckDuckGoBrowserWebSearchProvider({
    browserSession: session,
    loadTimeoutMs: 100,
    retryAttempts: 3,
    retryDelayMs: 0
  })

  const result = await provider.search({ query: 'site:github.com yachiyo', limit: 10 })

  assert.equal(attempts, 1)
  assert.equal(disposed, 1)
  assert.equal(result.failureCode, 'provider-failed')
  assert.match(result.error ?? '', /bot challenge/i)
})

test('DuckDuckGo browser provider still retries transient readiness timeouts', async () => {
  let attempts = 0
  const session = new BrowserSearchSession({
    profilePath: '/tmp/yachiyo-web-search-profile',
    pageFactory: {
      async createPage() {
        attempts += 1
        const currentAttempt = attempts
        return {
          async loadURL() {
            return undefined
          },
          async waitForFunction() {
            if (currentAttempt < 3) {
              throw new Error('Timed out after 100ms waiting for page readiness.')
            }
          },
          async evaluate<TResult>() {
            return [
              {
                href: 'https://example.com/result',
                title: 'Recovered result',
                snippet: 'Available after retry'
              }
            ] as TResult
          },
          async getURL() {
            return 'https://html.duckduckgo.com/html/'
          }
        }
      },
      async disposePage() {
        return undefined
      }
    }
  })
  const provider = createDuckDuckGoBrowserWebSearchProvider({
    browserSession: session,
    loadTimeoutMs: 100,
    retryAttempts: 3,
    retryDelayMs: 0
  })

  const result = await provider.search({ query: 'yachiyo electron', limit: 10 })

  assert.equal(attempts, 3)
  assert.equal(result.failureCode, undefined)
  assert.deepEqual(result.results, [
    {
      rank: 1,
      title: 'Recovered result',
      url: 'https://example.com/result',
      snippet: 'Available after retry'
    }
  ])
})
