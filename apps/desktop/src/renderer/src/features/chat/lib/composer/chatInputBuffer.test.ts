import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CHAT_INPUT_BUFFER_EXTEND_WAIT_MS,
  CHAT_INPUT_BUFFER_INITIAL_WAIT_MS,
  EMPTY_CHAT_INPUT_BUFFER_STATE,
  clearChatInputBuffer,
  getChatInputBufferProgress,
  stageChatInputBuffer,
  type ChatInputBufferPayload
} from './chatInputBuffer.ts'

function makePayload(overrides: Partial<ChatInputBufferPayload> = {}): ChatInputBufferPayload {
  return {
    sourceThreadId: 'thread-1',
    content: 'hello',
    images: [],
    attachments: [],
    enabledSkillNames: undefined,
    ...overrides
  }
}

test('stageChatInputBuffer starts a fresh window with INITIAL wait on empty state', () => {
  const t0 = 1_000
  const next = stageChatInputBuffer(
    EMPTY_CHAT_INPUT_BUFFER_STATE,
    makePayload({ content: 'a' }),
    t0
  )

  assert.equal(next.staged?.content, 'a')
  assert.equal(next.flushAt, t0 + CHAT_INPUT_BUFFER_INITIAL_WAIT_MS)
  assert.equal(next.waitMs, CHAT_INPUT_BUFFER_INITIAL_WAIT_MS)
})

test('stageChatInputBuffer merges content with \\n and resets to EXTEND wait', () => {
  const t0 = 0
  const first = stageChatInputBuffer(
    EMPTY_CHAT_INPUT_BUFFER_STATE,
    makePayload({ content: 'a' }),
    t0
  )

  const t1 = 500
  const second = stageChatInputBuffer(first, makePayload({ content: 'b' }), t1)

  assert.equal(second.staged?.content, 'a\nb')
  assert.equal(second.flushAt, t1 + CHAT_INPUT_BUFFER_EXTEND_WAIT_MS)
  assert.equal(second.waitMs, CHAT_INPUT_BUFFER_EXTEND_WAIT_MS)
})

test('stageChatInputBuffer preserves single side when the other content is empty', () => {
  const t0 = 0
  const first = stageChatInputBuffer(
    EMPTY_CHAT_INPUT_BUFFER_STATE,
    makePayload({ content: 'only' }),
    t0
  )
  const second = stageChatInputBuffer(first, makePayload({ content: '' }), 100)

  assert.equal(second.staged?.content, 'only')

  const third = stageChatInputBuffer(EMPTY_CHAT_INPUT_BUFFER_STATE, makePayload({ content: '' }), 0)
  const fourth = stageChatInputBuffer(third, makePayload({ content: 'later' }), 100)
  assert.equal(fourth.staged?.content, 'later')
})

test('stageChatInputBuffer concatenates images and attachments across stages', () => {
  const img1 = { dataUrl: 'data:image/png;base64,a', mediaType: 'image/png' as const }
  const img2 = { dataUrl: 'data:image/png;base64,b', mediaType: 'image/png' as const }
  const att1 = { dataUrl: 'data:text/plain;base64,x', mediaType: 'text/plain', filename: 'x.txt' }
  const att2 = { dataUrl: 'data:text/plain;base64,y', mediaType: 'text/plain', filename: 'y.txt' }

  const first = stageChatInputBuffer(
    EMPTY_CHAT_INPUT_BUFFER_STATE,
    makePayload({ content: 'a', images: [img1], attachments: [att1] }),
    0
  )
  const second = stageChatInputBuffer(
    first,
    makePayload({ content: 'b', images: [img2], attachments: [att2] }),
    10
  )

  assert.deepEqual(second.staged?.images, [img1, img2])
  assert.deepEqual(second.staged?.attachments, [att1, att2])
})

test('stageChatInputBuffer uses latest enabledSkillNames when the new stage sets it', () => {
  const first = stageChatInputBuffer(
    EMPTY_CHAT_INPUT_BUFFER_STATE,
    makePayload({ content: 'a', enabledSkillNames: ['one'] }),
    0
  )
  const second = stageChatInputBuffer(
    first,
    makePayload({ content: 'b', enabledSkillNames: ['two'] }),
    10
  )
  assert.deepEqual(second.staged?.enabledSkillNames, ['two'])
})

test('stageChatInputBuffer keeps previous enabledSkillNames when new stage omits it', () => {
  const first = stageChatInputBuffer(
    EMPTY_CHAT_INPUT_BUFFER_STATE,
    makePayload({ content: 'a', enabledSkillNames: ['one'] }),
    0
  )
  const second = stageChatInputBuffer(
    first,
    makePayload({ content: 'b', enabledSkillNames: undefined }),
    10
  )
  assert.deepEqual(second.staged?.enabledSkillNames, ['one'])
})

test('stageChatInputBuffer keeps the first-staged sourceThreadId across merges', () => {
  const first = stageChatInputBuffer(
    EMPTY_CHAT_INPUT_BUFFER_STATE,
    makePayload({ content: 'a', sourceThreadId: 'thread-a' }),
    0
  )
  const second = stageChatInputBuffer(
    first,
    makePayload({ content: 'b', sourceThreadId: 'thread-b' }),
    10
  )
  assert.equal(second.staged?.sourceThreadId, 'thread-a')
})

test('clearChatInputBuffer returns the empty state', () => {
  assert.deepEqual(clearChatInputBuffer(), EMPTY_CHAT_INPUT_BUFFER_STATE)
})

test('getChatInputBufferProgress is 0 before any wait elapses and reaches 1 at deadline', () => {
  const t0 = 1_000
  const state = stageChatInputBuffer(
    EMPTY_CHAT_INPUT_BUFFER_STATE,
    makePayload({ content: 'a' }),
    t0
  )

  assert.equal(getChatInputBufferProgress(state, t0), 0)
  assert.equal(getChatInputBufferProgress(state, t0 + CHAT_INPUT_BUFFER_INITIAL_WAIT_MS / 2), 0.5)
  assert.equal(getChatInputBufferProgress(state, t0 + CHAT_INPUT_BUFFER_INITIAL_WAIT_MS), 1)
  assert.equal(getChatInputBufferProgress(state, t0 + CHAT_INPUT_BUFFER_INITIAL_WAIT_MS + 50), 1)
})

test('getChatInputBufferProgress is 0 for an empty buffer', () => {
  assert.equal(getChatInputBufferProgress(EMPTY_CHAT_INPUT_BUFFER_STATE, 5_000), 0)
})
