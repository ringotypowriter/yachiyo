import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createWebSearchProviderSelector,
  type WebSearchProviderRegistration
} from './webSearchProviderSelector.ts'
import type { WebSearchProvider } from './webSearchService.ts'

function provider(id: string): WebSearchProvider {
  return {
    id,
    async search({ query }) {
      return { provider: id, query, results: [] }
    }
  }
}

function registration(id: string, baseWeight: number): WebSearchProviderRegistration {
  return { provider: provider(id), baseWeight }
}

test('selector chooses the available provider with the highest current score', () => {
  const selector = createWebSearchProviderSelector({
    providers: [registration('low', 2), registration('high', 5)],
    now: () => 0
  })

  assert.equal(selector.select(new Set())?.provider.id, 'high')
})

test('selector excludes unavailable, attempted, and cooling providers', () => {
  let now = 0
  const unavailable = provider('unavailable')
  unavailable.isAvailable = () => false
  const selector = createWebSearchProviderSelector({
    providers: [
      { provider: unavailable, baseWeight: 10 },
      registration('failed', 5),
      registration('ready', 4)
    ],
    now: () => now
  })

  selector.begin('failed')
  selector.complete('failed', 100, 'provider-failed')

  assert.equal(selector.select(new Set())?.provider.id, 'ready')
  assert.equal(selector.select(new Set(['ready'])), undefined)

  now = 15 * 60_000
  assert.equal(selector.select(new Set(['ready']))?.provider.id, 'failed')
})

test('selector applies short cooldowns to transient failures', () => {
  let now = 0
  const selector = createWebSearchProviderSelector({
    providers: [registration('transient', 5), registration('fallback', 4)],
    now: () => now
  })

  selector.begin('transient')
  selector.complete('transient', 100, 'load-failed')
  assert.equal(selector.select(new Set())?.provider.id, 'fallback')

  now = 60_000
  assert.equal(selector.select(new Set(['fallback']))?.provider.id, 'transient')
})

test('selector success clears failures and updates EWMA health', () => {
  let now = 0
  const selector = createWebSearchProviderSelector({
    providers: [registration('primary', 5)],
    now: () => now
  })

  selector.begin('primary')
  selector.complete('primary', 10_000, 'provider-failed')
  now = 15 * 60_000
  selector.begin('primary')
  selector.complete('primary', 1_000)

  const state = selector.getState('primary')
  assert.equal(state?.consecutiveFailures, 0)
  assert.equal(state?.cooldownUntil, 0)
  assert.equal(state?.successRate, 0.53125)
  assert.equal(state?.latencyMs, 7_750)
})

test('selector penalizes in-flight work and rewards idle exploration', () => {
  let now = 0
  const selector = createWebSearchProviderSelector({
    providers: [registration('busy', 5), registration('idle', 4)],
    now: () => now
  })

  selector.begin('busy')
  assert.equal(selector.select(new Set())?.provider.id, 'idle')

  selector.complete('busy', 100)
  selector.begin('idle')
  selector.complete('idle', 100)
  now = 5 * 60_000

  selector.begin('busy')
  selector.complete('busy', 100)
  assert.equal(selector.select(new Set())?.provider.id, 'idle')
})

test('selector ignores aborted and invalid-query outcomes when updating health', () => {
  const selector = createWebSearchProviderSelector({
    providers: [registration('provider', 5)],
    now: () => 0
  })

  selector.begin('provider')
  selector.complete('provider', 1_000, 'aborted')
  selector.begin('provider')
  selector.complete('provider', 1_000, 'invalid-query')

  const state = selector.getState('provider')
  assert.equal(state?.inFlight, 0)
  assert.equal(state?.successRate, 0.5)
  assert.equal(state?.latencyMs, 0)
  assert.equal(state?.consecutiveFailures, 0)
})
