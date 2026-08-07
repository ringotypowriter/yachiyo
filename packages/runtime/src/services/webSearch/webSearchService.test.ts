import assert from 'node:assert/strict'
import test from 'node:test'

import type { WebSearchProviderRegistration } from './webSearchProviderSelector.ts'
import {
  createWebSearchService,
  type WebSearchProvider,
  type WebSearchResult
} from './webSearchService.ts'

function success(provider: string, query: string): WebSearchResult {
  return {
    provider,
    query,
    results: [{ rank: 1, title: `${provider} result`, url: `https://${provider}.example` }]
  }
}

function failure(
  provider: string,
  query: string,
  failureCode: NonNullable<WebSearchResult['failureCode']>
): WebSearchResult {
  return {
    provider,
    query,
    results: [],
    failureCode,
    error: `${provider} failed`
  }
}

function register(provider: WebSearchProvider, baseWeight: number): WebSearchProviderRegistration {
  return { provider, baseWeight }
}

test('service rejects an invalid query without invoking a provider', async () => {
  let calls = 0
  const service = createWebSearchService({
    providers: [
      register(
        {
          id: 'provider',
          async search({ query }) {
            calls += 1
            return success('provider', query)
          }
        },
        5
      )
    ]
  })

  const result = await service.search({ query: ' \n ' })

  assert.equal(calls, 0)
  assert.equal(result.provider, 'auto')
  assert.equal(result.failureCode, 'invalid-query')
})

test('service skips unavailable providers and calls the highest-scoring candidate first', async () => {
  const calls: string[] = []
  const unavailable: WebSearchProvider = {
    id: 'unavailable',
    isAvailable: () => false,
    async search({ query }) {
      calls.push('unavailable')
      return success('unavailable', query)
    }
  }
  const service = createWebSearchService({
    providers: [
      register(unavailable, 10),
      register(
        {
          id: 'lower',
          async search({ query }) {
            calls.push('lower')
            return success('lower', query)
          }
        },
        2
      ),
      register(
        {
          id: 'higher',
          async search({ query }) {
            calls.push('higher')
            return success('higher', query)
          }
        },
        5
      )
    ]
  })

  const result = await service.search({ query: 'test' })

  assert.deepEqual(calls, ['higher'])
  assert.equal(result.provider, 'higher')
})

test('service rescoring falls back through untried providers until one succeeds', async () => {
  const calls: string[] = []
  const service = createWebSearchService({
    providers: [
      register(
        {
          id: 'first',
          async search({ query }) {
            calls.push('first')
            return failure('first', query, 'provider-failed')
          }
        },
        5
      ),
      register(
        {
          id: 'second',
          async search({ query }) {
            calls.push('second')
            return failure('second', query, 'load-failed')
          }
        },
        4
      ),
      register(
        {
          id: 'third',
          async search({ query, limit }) {
            calls.push(`third:${limit}`)
            return success('third', query)
          }
        },
        3
      )
    ]
  })

  const result = await service.search({ query: 'test', limit: 7 })

  assert.deepEqual(calls, ['first', 'second', 'third:7'])
  assert.equal(result.provider, 'third')
  assert.equal(result.results[0]?.title, 'third result')
})

test('service stops immediately on aborted results without penalizing the provider', async () => {
  let fallbackCalls = 0
  let abortFirst = true
  const service = createWebSearchService({
    providers: [
      register(
        {
          id: 'primary',
          async search({ query }) {
            if (abortFirst) {
              abortFirst = false
              return failure('primary', query, 'aborted')
            }
            return success('primary', query)
          }
        },
        5
      ),
      register(
        {
          id: 'fallback',
          async search({ query }) {
            fallbackCalls += 1
            return success('fallback', query)
          }
        },
        4
      )
    ],
    now: () => 0
  })

  const aborted = await service.search({ query: 'test' })
  const recovered = await service.search({ query: 'test again' })

  assert.equal(aborted.failureCode, 'aborted')
  assert.equal(fallbackCalls, 0)
  assert.equal(recovered.provider, 'primary')
})

test('service maps thrown aborts and provider errors into fallback behavior', async () => {
  const service = createWebSearchService({
    providers: [
      register(
        {
          id: 'throws',
          async search() {
            throw new Error('network broke')
          }
        },
        5
      ),
      register(
        {
          id: 'fallback',
          async search({ query }) {
            return success('fallback', query)
          }
        },
        4
      )
    ]
  })

  assert.equal((await service.search({ query: 'test' })).provider, 'fallback')

  const abortService = createWebSearchService({
    providers: [
      register(
        {
          id: 'abort',
          async search() {
            throw new DOMException('stopped', 'AbortError')
          }
        },
        5
      )
    ]
  })
  assert.equal((await abortService.search({ query: 'test' })).failureCode, 'aborted')
})

test('service returns the last failure after all available providers fail', async () => {
  const service = createWebSearchService({
    providers: [
      register(
        {
          id: 'first',
          async search({ query }) {
            return failure('first', query, 'provider-failed')
          }
        },
        5
      ),
      register(
        {
          id: 'last',
          async search({ query }) {
            return failure('last', query, 'extraction-failed')
          }
        },
        4
      )
    ]
  })

  const result = await service.search({ query: 'test' })

  assert.equal(result.provider, 'last')
  assert.equal(result.failureCode, 'extraction-failed')
  assert.match(result.error ?? '', /last failed/)
  assert.match(result.error ?? '', /all available web search providers failed/i)
})

test('service reports when no provider is currently available', async () => {
  const service = createWebSearchService({
    providers: [
      register(
        {
          id: 'unavailable',
          isAvailable: () => false,
          async search({ query }) {
            return success('unavailable', query)
          }
        },
        5
      )
    ]
  })

  const result = await service.search({ query: 'test' })

  assert.equal(result.provider, 'auto')
  assert.equal(result.failureCode, 'unsupported-provider')
  assert.match(result.error ?? '', /No web search providers are available/)
})

test('concurrent searches use the in-flight penalty to spread work', async () => {
  const calls: string[] = []
  let releasePrimary: (() => void) | undefined
  const primaryStarted = new Promise<void>((resolve) => {
    releasePrimary = resolve
  })
  let unblockPrimary: (() => void) | undefined
  const primaryBlocked = new Promise<void>((resolve) => {
    unblockPrimary = resolve
  })
  const service = createWebSearchService({
    providers: [
      register(
        {
          id: 'primary',
          async search({ query }) {
            calls.push('primary')
            releasePrimary?.()
            await primaryBlocked
            return success('primary', query)
          }
        },
        5
      ),
      register(
        {
          id: 'secondary',
          async search({ query }) {
            calls.push('secondary')
            return success('secondary', query)
          }
        },
        4
      )
    ],
    now: () => 0
  })

  const first = service.search({ query: 'first' })
  await primaryStarted
  const second = await service.search({ query: 'second' })
  unblockPrimary?.()
  await first

  assert.deepEqual(calls, ['primary', 'secondary'])
  assert.equal(second.provider, 'secondary')
})
