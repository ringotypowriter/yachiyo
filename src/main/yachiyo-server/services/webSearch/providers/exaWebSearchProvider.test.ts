import assert from 'node:assert/strict'
import test from 'node:test'

import type { SettingsConfig } from '../../../../../shared/yachiyo/protocol.ts'
import { createExaWebSearchProvider } from './exaWebSearchProvider.ts'

function makeConfig(exa?: { apiKey?: string; baseUrl?: string }): SettingsConfig {
  return {
    providers: [],
    webSearch: { defaultProvider: 'exa', exa }
  }
}

function createMockFetch(status: number, body: unknown): typeof globalThis.fetch {
  return async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
}

test('exa provider returns failure when API key is missing', async () => {
  const provider = createExaWebSearchProvider({
    readConfig: () => makeConfig()
  })

  const result = await provider.search({ query: 'test', limit: 5 })

  assert.equal(result.provider, 'exa')
  assert.equal(result.failureCode, 'provider-failed')
  assert.match(result.error ?? '', /API key/)
})

test('exa provider sends correct request and maps results', async () => {
  let capturedRequest: { url: string; init: RequestInit } | undefined

  const fakeFetch: typeof globalThis.fetch = async (input, init) => {
    capturedRequest = { url: String(input), init: init! }
    return new Response(
      JSON.stringify({
        results: [
          { id: '1', url: 'https://example.com', title: 'Example', text: 'A snippet', score: 0.9 },
          { id: '2', url: 'https://other.com', title: 'Other' }
        ]
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }

  const provider = createExaWebSearchProvider({
    readConfig: () => makeConfig({ apiKey: 'test-key' }),
    fetchImpl: fakeFetch
  })

  const result = await provider.search({ query: 'hello world', limit: 3 })

  assert.equal(result.provider, 'exa')
  assert.equal(result.results.length, 2)
  assert.equal(result.results[0].title, 'Example')
  assert.equal(result.results[0].url, 'https://example.com')
  assert.equal(result.results[0].snippet, 'A snippet')
  assert.equal(result.results[0].rank, 1)
  assert.equal(result.results[1].rank, 2)
  assert.ok(!result.results[1].snippet)
  assert.ok(!result.failureCode)

  assert.ok(capturedRequest)
  assert.equal(capturedRequest.url, 'https://api.exa.ai/search')
  assert.equal((capturedRequest.init.headers as Record<string, string>)['x-api-key'], 'test-key')
  const body = JSON.parse(capturedRequest.init.body as string)
  assert.equal(body.query, 'hello world')
  assert.equal(body.numResults, 3)
})

test('exa provider uses custom base URL', async () => {
  let capturedUrl = ''

  const fakeFetch: typeof globalThis.fetch = async (input) => {
    capturedUrl = String(input)
    return new Response(JSON.stringify({ results: [] }), { status: 200 })
  }

  const provider = createExaWebSearchProvider({
    readConfig: () => makeConfig({ apiKey: 'key', baseUrl: 'https://custom.exa.ai/' }),
    fetchImpl: fakeFetch
  })

  await provider.search({ query: 'test', limit: 5 })
  assert.equal(capturedUrl, 'https://custom.exa.ai/search')
})

test('exa provider returns failure on HTTP error', async () => {
  const provider = createExaWebSearchProvider({
    readConfig: () => makeConfig({ apiKey: 'key' }),
    fetchImpl: createMockFetch(401, { error: 'Unauthorized' })
  })

  const result = await provider.search({ query: 'test', limit: 5 })

  assert.equal(result.failureCode, 'provider-failed')
  assert.match(result.error ?? '', /401/)
})

test('exa provider returns failure on invalid JSON response', async () => {
  const provider = createExaWebSearchProvider({
    readConfig: () => makeConfig({ apiKey: 'key' }),
    fetchImpl: async () => new Response('not json', { status: 200 })
  })

  const result = await provider.search({ query: 'test', limit: 5 })

  assert.equal(result.failureCode, 'extraction-failed')
})

test('exa provider integrates with webSearchService for provider selection', async () => {
  const { createWebSearchService } = await import('../webSearchService.ts')

  const service = createWebSearchService({
    providers: [
      {
        id: 'google-browser',
        search: async ({ query }) => ({
          provider: 'google-browser',
          query,
          results: [{ rank: 1, title: 'Google result', url: 'https://g.co' }]
        })
      },
      createExaWebSearchProvider({
        readConfig: () => makeConfig({ apiKey: 'test-key' }),
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              results: [{ id: '1', url: 'https://exa.ai', title: 'Exa result' }]
            }),
            { status: 200 }
          )
      })
    ],
    readConfig: () => makeConfig({ apiKey: 'test-key' })
  })

  const result = await service.search({ query: 'test' })

  assert.equal(result.provider, 'exa')
  assert.equal(result.results[0].title, 'Exa result')
})
