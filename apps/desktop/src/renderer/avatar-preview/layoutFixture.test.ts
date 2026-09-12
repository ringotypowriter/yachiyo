import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLayoutPreviewState, PREVIEW_THREAD_ID } from './layoutFixture.ts'
import { selectRunAvatarPhase } from '../src/features/chat/lib/runAvatarState.ts'
import { useAppStore } from '../src/app/store/useAppStore.ts'

const now = '2026-09-12T14:00:00.000Z'

test('preview scenarios exercise the real avatar state mapping', () => {
  for (const phase of ['idle', 'loading', 'thinking', 'speaking', 'working', 'waiting'] as const) {
    const state = {
      ...useAppStore.getInitialState(),
      ...buildLayoutPreviewState(phase, false, now)
    }
    assert.equal(selectRunAvatarPhase(state, PREVIEW_THREAD_ID), phase)
    assert.equal(state.messages[PREVIEW_THREAD_ID].length, 4)
    assert.ok(state.messages[PREVIEW_THREAD_ID].at(-1)!.content.length > 3500)
  }
})

test('welcome clears the selected conversation without deleting its sample history', () => {
  const state = buildLayoutPreviewState('idle', true, now)
  assert.equal(state.activeThreadId, null)
  assert.ok(state.messages?.[PREVIEW_THREAD_ID].length)
  assert.deepEqual(state.activeRunIdsByThread, {})
})

test('all phases keep conversation and message identities stable', () => {
  const idle = buildLayoutPreviewState('idle', false, now)
  const speaking = buildLayoutPreviewState('speaking', false, now)
  assert.deepEqual(
    idle.messages?.[PREVIEW_THREAD_ID].map((message) => message.id),
    speaking.messages?.[PREVIEW_THREAD_ID].map((message) => message.id)
  )
})
