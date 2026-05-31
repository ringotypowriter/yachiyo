import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveWelcomeState, type WelcomeStateInput } from './welcomeState.ts'

function baseInput(overrides: Partial<WelcomeStateInput> = {}): WelcomeStateInput {
  return {
    activeSurface: 'timeline',
    activeThreadId: null,
    activeThreadMessagesLoaded: true,
    messageCount: 0,
    activeEssentialId: null,
    activeThreadCreatedFromEssentialId: null,
    hasActiveEssential: false,
    ...overrides
  }
}

test('shows generic welcome for a new plain empty thread', () => {
  assert.deepEqual(resolveWelcomeState(baseInput()), {
    variant: 'generic',
    essentialSourceId: null
  })
})

test('shows essential welcome for a new essential empty thread', () => {
  assert.deepEqual(
    resolveWelcomeState(
      baseInput({
        activeEssentialId: 'writer',
        hasActiveEssential: true
      })
    ),
    {
      variant: 'essential',
      essentialSourceId: 'writer'
    }
  )
})

test('does not show welcome while an existing thread message list is still loading', () => {
  assert.deepEqual(
    resolveWelcomeState(
      baseInput({
        activeThreadId: 'thread-1',
        activeThreadMessagesLoaded: false
      })
    ),
    {
      variant: null,
      essentialSourceId: null
    }
  )
})

test('shows welcome for an existing thread only after its empty message list is loaded', () => {
  assert.deepEqual(
    resolveWelcomeState(
      baseInput({
        activeThreadId: 'thread-1',
        activeThreadMessagesLoaded: true
      })
    ),
    {
      variant: 'generic',
      essentialSourceId: null
    }
  )
})

test('keeps essential identity from the materialized thread after messages load', () => {
  assert.deepEqual(
    resolveWelcomeState(
      baseInput({
        activeThreadId: 'thread-1',
        activeThreadMessagesLoaded: true,
        activeThreadCreatedFromEssentialId: 'writer',
        hasActiveEssential: true
      })
    ),
    {
      variant: 'essential',
      essentialSourceId: 'writer'
    }
  )
})

test('does not show welcome for non-empty threads or browser surface', () => {
  assert.deepEqual(resolveWelcomeState(baseInput({ messageCount: 1 })), {
    variant: null,
    essentialSourceId: null
  })
  assert.deepEqual(resolveWelcomeState(baseInput({ activeSurface: 'browser' })), {
    variant: null,
    essentialSourceId: null
  })
})
