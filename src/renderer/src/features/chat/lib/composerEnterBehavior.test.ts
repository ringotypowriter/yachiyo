import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveComposerEnterAction } from './composerEnterBehavior.ts'

test('returns false while IME composition is active', () => {
  assert.equal(
    resolveComposerEnterAction({
      activeRunEnterBehavior: 'enter-steers',
      event: {
        key: 'Enter',
        altKey: false,
        shiftKey: false,
        isComposing: true,
        keyCode: 13
      },
      hasActiveRun: false
    }),
    null
  )
})

test('returns false for the IME processing key event reported as keyCode 229', () => {
  assert.equal(
    resolveComposerEnterAction({
      activeRunEnterBehavior: 'enter-steers',
      event: {
        key: 'Enter',
        altKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 229
      },
      hasActiveRun: false
    }),
    null
  )
})

test('returns false when Enter should insert a newline or another key is pressed', () => {
  assert.equal(
    resolveComposerEnterAction({
      activeRunEnterBehavior: 'enter-steers',
      event: {
        key: 'Enter',
        altKey: false,
        shiftKey: true,
        isComposing: false,
        keyCode: 13
      },
      hasActiveRun: false
    }),
    null
  )

  assert.equal(
    resolveComposerEnterAction({
      activeRunEnterBehavior: 'enter-steers',
      event: {
        key: 'Escape',
        altKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 27
      },
      hasActiveRun: false
    }),
    null
  )
})

test('uses plain Enter for idle sends regardless of the active-run preference', () => {
  assert.equal(
    resolveComposerEnterAction({
      activeRunEnterBehavior: 'enter-queues-follow-up',
      event: {
        key: 'Enter',
        altKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 13
      },
      hasActiveRun: false
    }),
    'send'
  )
})

test('maps Enter to steer and Alt+Enter to follow-up while a run is active in the default mode', () => {
  assert.equal(
    resolveComposerEnterAction({
      activeRunEnterBehavior: 'enter-steers',
      event: {
        key: 'Enter',
        altKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 13
      },
      hasActiveRun: true
    }),
    'steer'
  )

  assert.equal(
    resolveComposerEnterAction({
      activeRunEnterBehavior: 'enter-steers',
      event: {
        key: 'Enter',
        altKey: true,
        shiftKey: false,
        isComposing: false,
        keyCode: 13
      },
      hasActiveRun: true
    }),
    'follow-up'
  )
})

test('maps Alt+Enter to steer and Enter to follow-up in the alternate active-run mode', () => {
  assert.equal(
    resolveComposerEnterAction({
      activeRunEnterBehavior: 'enter-queues-follow-up',
      event: {
        key: 'Enter',
        altKey: true,
        shiftKey: false,
        isComposing: false,
        keyCode: 13
      },
      hasActiveRun: true
    }),
    'steer'
  )

  assert.equal(
    resolveComposerEnterAction({
      activeRunEnterBehavior: 'enter-queues-follow-up',
      event: {
        key: 'Enter',
        altKey: false,
        shiftKey: false,
        isComposing: false,
        keyCode: 13
      },
      hasActiveRun: true
    }),
    'follow-up'
  )
})
