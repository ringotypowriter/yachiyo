import assert from 'node:assert/strict'
import test from 'node:test'
import { createInMemoryYachiyoStorage } from './memoryStorage.ts'
import type { MessageRecord, ThreadRecord } from '../../../shared/yachiyo/protocol.ts'

function makeThread(overrides: Partial<ThreadRecord> & { id: string }): ThreadRecord {
  return {
    title: 'Untitled',
    updatedAt: new Date().toISOString(),
    ...overrides
  }
}

function makeMessage(
  overrides: Partial<MessageRecord> & { id: string; threadId: string }
): MessageRecord {
  return {
    role: 'user',
    content: '',
    status: 'completed',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

const NOW = '2024-01-01T00:00:00.000Z'

function setupStorage(): ReturnType<typeof createInMemoryYachiyoStorage> {
  const storage = createInMemoryYachiyoStorage()

  storage.createThread({
    thread: makeThread({ id: 'thread-1', title: 'TypeScript discussion', updatedAt: NOW }),
    createdAt: NOW,
    messages: [
      makeMessage({
        id: 'msg-1',
        threadId: 'thread-1',
        content: 'How do I use generics in TypeScript?',
        createdAt: NOW
      }),
      makeMessage({
        id: 'msg-2',
        threadId: 'thread-1',
        role: 'assistant',
        content: 'Generics allow you to write reusable code.',
        createdAt: NOW
      })
    ]
  })

  storage.createThread({
    thread: makeThread({ id: 'thread-2', title: 'React hooks', updatedAt: NOW }),
    createdAt: NOW,
    messages: [
      makeMessage({
        id: 'msg-3',
        threadId: 'thread-2',
        content: 'What is useState used for?',
        createdAt: NOW
      })
    ]
  })

  storage.createThread({
    thread: makeThread({ id: 'thread-3', title: 'Unrelated topic', updatedAt: NOW }),
    createdAt: NOW,
    messages: [
      makeMessage({
        id: 'msg-4',
        threadId: 'thread-3',
        content: 'The weather is nice today.',
        createdAt: NOW
      })
    ]
  })

  return storage
}

test('returns empty array for blank query', () => {
  const storage = setupStorage()
  assert.deepEqual(storage.searchThreadsAndMessages({ query: '' }), [])
  assert.deepEqual(storage.searchThreadsAndMessages({ query: '   ' }), [])
})

test('finds thread by title match', () => {
  const storage = setupStorage()
  const results = storage.searchThreadsAndMessages({ query: 'TypeScript' })
  assert.ok(results.length >= 1)
  const hit = results.find((r) => r.threadId === 'thread-1')
  assert.ok(hit, 'thread-1 should be in results')
  assert.equal(hit.titleMatched, true)
})

test('finds thread by message content match', () => {
  const storage = setupStorage()
  const results = storage.searchThreadsAndMessages({ query: 'useState' })
  assert.ok(results.length >= 1)
  const hit = results.find((r) => r.threadId === 'thread-2')
  assert.ok(hit, 'thread-2 should be in results')
  assert.ok(hit.messageMatch, 'should have a message match')
  assert.equal(hit.messageMatch?.messageId, 'msg-3')
  assert.ok(hit.messageMatch?.snippet.includes('useState'))
})

test('associates results with the correct thread', () => {
  const storage = setupStorage()
  const results = storage.searchThreadsAndMessages({ query: 'generics' })
  assert.equal(results.length, 1)
  assert.equal(results[0].threadId, 'thread-1')
  assert.equal(results[0].messageMatch?.messageId, 'msg-1')
})

test('returns no results when query does not match anything', () => {
  const storage = setupStorage()
  const results = storage.searchThreadsAndMessages({ query: 'xyzzy-no-match' })
  assert.deepEqual(results, [])
})

test('thread appearing in both title and message match has titleMatched=true', () => {
  const storage = setupStorage()
  // "TypeScript" matches both thread-1 title and msg-1 content
  const results = storage.searchThreadsAndMessages({ query: 'TypeScript' })
  const hit = results.find((r) => r.threadId === 'thread-1')
  assert.ok(hit)
  assert.equal(hit.titleMatched, true)
})

test('snippet is extracted from matched message content', () => {
  const storage = setupStorage()
  const results = storage.searchThreadsAndMessages({ query: 'reusable' })
  const hit = results.find((r) => r.threadId === 'thread-1')
  assert.ok(hit)
  assert.ok(hit.messageMatch?.snippet.includes('reusable'))
})

test('does not return archived threads', () => {
  const storage = setupStorage()
  storage.archiveThread({ threadId: 'thread-1', archivedAt: NOW, updatedAt: NOW })
  const results = storage.searchThreadsAndMessages({ query: 'TypeScript' })
  assert.ok(!results.find((r) => r.threadId === 'thread-1'))
})

test('each result has required fields', () => {
  const storage = setupStorage()
  const results = storage.searchThreadsAndMessages({ query: 'React' })
  for (const result of results) {
    assert.ok(typeof result.threadId === 'string')
    assert.ok(typeof result.threadTitle === 'string')
    assert.ok(typeof result.threadUpdatedAt === 'string')
    assert.ok(typeof result.titleMatched === 'boolean')
  }
})
