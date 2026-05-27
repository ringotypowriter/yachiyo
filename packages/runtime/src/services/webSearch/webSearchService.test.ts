import assert from 'node:assert/strict'
import test from 'node:test'

import { createWebSearchService, resolveWebSearchProviderId } from './webSearchService.ts'

test('createWebSearchService resolves the configured default provider and returns provider-neutral results', async () => {
  const service = createWebSearchService({
    providers: [
      {
        id: 'google-browser',
        search: async ({ query, limit }) => ({
          provider: 'google-browser',
          query,
          searchUrl: 'https://www.google.com/search?q=test',
          finalUrl: 'https://www.google.com/search?q=test',
          results: [
            {
              rank: 1,
              title: 'Result',
              url: 'https://example.com/result',
              snippet: `limit=${limit}`
            }
          ]
        })
      }
    ],
    readConfig: () => ({
      providers: [],
      webSearch: {
        defaultProvider: 'google-browser'
      }
    })
  })

  const result = await service.search({
    query: 'test'
  })

  assert.equal(result.provider, 'google-browser')
  assert.equal(result.results[0]?.rank, 1)
  assert.equal(result.results[0]?.snippet, 'limit=5')
})

test('createWebSearchService rejects unsupported providers without invoking a provider', async () => {
  let calls = 0
  const service = createWebSearchService({
    providers: [
      {
        id: 'google-browser',
        search: async () => {
          calls += 1
          return {
            provider: 'google-browser',
            query: 'ignored',
            results: []
          }
        }
      }
    ],
    readConfig: () => ({
      providers: [],
      webSearch: {
        defaultProvider: 'exa'
      }
    })
  })

  const result = await service.search({
    query: 'test'
  })

  assert.equal(calls, 0)
  assert.equal(result.failureCode, 'unsupported-provider')
  assert.match(result.error ?? '', /Unsupported web search provider/)
})

test('resolveWebSearchProviderId falls back to google-browser', () => {
  assert.equal(resolveWebSearchProviderId({ providers: [] }), 'google-browser')
})
