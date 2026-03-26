import assert from 'node:assert/strict'
import test from 'node:test'

import { getComposerActionState } from './composerActionState.ts'

test('getComposerActionState shows the stop button whenever a run is active and still allows sends when the payload is ready', () => {
  assert.deepEqual(
    getComposerActionState({
      connectionStatus: 'connected',
      hasActiveRun: true,
      hasFailedImages: false,
      hasLoadingImages: false,
      hasPayload: true,
      isConfigured: true
    }),
    {
      canSend: true,
      showStopButton: true
    }
  )
})

test('getComposerActionState enables send only when the composer is ready and idle', () => {
  assert.deepEqual(
    getComposerActionState({
      connectionStatus: 'connected',
      hasActiveRun: false,
      hasFailedImages: false,
      hasLoadingImages: false,
      hasPayload: true,
      isConfigured: true
    }),
    {
      canSend: true,
      showStopButton: false
    }
  )
})

test('getComposerActionState disables send while the thread is saving', () => {
  assert.deepEqual(
    getComposerActionState({
      connectionStatus: 'connected',
      hasActiveRun: false,
      hasFailedImages: false,
      hasLoadingImages: false,
      hasPayload: true,
      isConfigured: true,
      threadIsSaving: true
    }),
    {
      canSend: false,
      showStopButton: false
    }
  )
})

test('getComposerActionState keeps send disabled when configuration or payload is missing', () => {
  assert.deepEqual(
    getComposerActionState({
      connectionStatus: 'connected',
      hasActiveRun: false,
      hasFailedImages: false,
      hasLoadingImages: false,
      hasPayload: false,
      isConfigured: true
    }),
    {
      canSend: false,
      showStopButton: false
    }
  )

  assert.deepEqual(
    getComposerActionState({
      connectionStatus: 'disconnected',
      hasActiveRun: false,
      hasFailedImages: false,
      hasLoadingImages: false,
      hasPayload: true,
      isConfigured: true
    }),
    {
      canSend: false,
      showStopButton: false
    }
  )
})
