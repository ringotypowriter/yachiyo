import assert from 'node:assert/strict'
import test from 'node:test'
import { createInMemoryYachiyoStorage } from './memoryStorage.ts'
import type { MessageRecord, ThreadRecord } from '@yachiyo/shared/protocol'

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
  assert.ok(hit.messageMatches.length > 0, 'should have message matches')
  assert.equal(hit.messageMatches[0].messageId, 'msg-3')
  assert.ok(hit.messageMatches[0].snippet.includes('useState'))
})

test('associates results with the correct thread', () => {
  const storage = setupStorage()
  const results = storage.searchThreadsAndMessages({ query: 'generics' })
  assert.equal(results.length, 1)
  assert.equal(results[0].threadId, 'thread-1')
  assert.equal(results[0].messageMatches[0].messageId, 'msg-1')
})

test('returns no results when query does not match anything', () => {
  const storage = setupStorage()
  const results = storage.searchThreadsAndMessages({ query: 'xyzzy-no-match' })
  assert.deepEqual(results, [])
})

test('thread appearing in both title and message match has titleMatched=true', () => {
  const storage = setupStorage()
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
  assert.ok(hit.messageMatches[0].snippet.includes('reusable'))
})

test('returns multiple message matches per thread', () => {
  const storage = createInMemoryYachiyoStorage()
  storage.createThread({
    thread: makeThread({ id: 'thread-multi', title: 'Multi match', updatedAt: NOW }),
    createdAt: NOW,
    messages: [
      makeMessage({
        id: 'mm-1',
        threadId: 'thread-multi',
        content: 'hello world first',
        createdAt: '2024-01-01T00:00:01.000Z'
      }),
      makeMessage({
        id: 'mm-2',
        threadId: 'thread-multi',
        content: 'hello world second',
        createdAt: '2024-01-01T00:00:02.000Z'
      }),
      makeMessage({
        id: 'mm-3',
        threadId: 'thread-multi',
        content: 'hello world third',
        createdAt: '2024-01-01T00:00:03.000Z'
      })
    ]
  })
  const results = storage.searchThreadsAndMessages({ query: 'hello' })
  const hit = results.find((r) => r.threadId === 'thread-multi')
  assert.ok(hit)
  assert.equal(hit.messageMatches.length, 3)
  assert.equal(hit.messageMatches[0].messageId, 'mm-1')
  assert.equal(hit.messageMatches[1].messageId, 'mm-2')
  assert.equal(hit.messageMatches[2].messageId, 'mm-3')
})

test('returns all message matches without cap', () => {
  const storage = createInMemoryYachiyoStorage()
  const messages = Array.from({ length: 5 }, (_, i) =>
    makeMessage({
      id: `cap-msg-${i}`,
      threadId: 'thread-cap',
      content: `target text message ${i}`,
      createdAt: `2024-01-01T00:00:0${i}.000Z`
    })
  )
  storage.createThread({
    thread: makeThread({ id: 'thread-cap', title: 'Cap test', updatedAt: NOW }),
    createdAt: NOW,
    messages
  })
  const results = storage.searchThreadsAndMessages({ query: 'target' })
  const hit = results.find((r) => r.threadId === 'thread-cap')
  assert.ok(hit)
  assert.equal(hit.messageMatches.length, 5)
})

test('does not return archived threads by default', () => {
  const storage = setupStorage()
  storage.archiveThread({ threadId: 'thread-1', archivedAt: NOW, updatedAt: NOW })
  const results = storage.searchThreadsAndMessages({ query: 'TypeScript' })
  assert.ok(!results.find((r) => r.threadId === 'thread-1'))
})

test('returns archived threads by title when scope is archived', () => {
  const storage = setupStorage()
  storage.archiveThread({ threadId: 'thread-1', archivedAt: NOW, updatedAt: NOW })
  const results = storage.searchThreadsAndMessages({ query: 'TypeScript', scope: 'archived' })
  const hit = results.find((r) => r.threadId === 'thread-1')
  assert.ok(hit)
  assert.equal(hit.titleMatched, true)
})

test('returns archived threads by message content when scope is archived', () => {
  const storage = setupStorage()
  storage.archiveThread({ threadId: 'thread-2', archivedAt: NOW, updatedAt: NOW })
  const results = storage.searchThreadsAndMessages({ query: 'useState', scope: 'archived' })
  const hit = results.find((r) => r.threadId === 'thread-2')
  assert.ok(hit)
  assert.equal(hit.messageMatches[0]?.messageId, 'msg-3')
})

test('searchThreadsAndMessagesFts matches short CJK queries via substring fallback', () => {
  const storage = setupStorage()
  storage.createThread({
    thread: makeThread({ id: 'thread-zh', title: '数据库迁移讨论', updatedAt: NOW }),
    createdAt: NOW,
    messages: [
      makeMessage({
        id: 'msg-zh',
        threadId: 'thread-zh',
        content: '我们在评审数据库迁移的方案，顺便聊聊搜索功能',
        createdAt: NOW
      })
    ]
  })
  // Two-character word — below the trigram minimum; the sqlite implementation
  // falls back to LIKE and must still return the thread, matching this mock.
  const results = storage.searchThreadsAndMessagesFts({ query: '搜索' })
  assert.ok(results.find((r) => r.threadId === 'thread-zh'))
})

test('searchThreadsAndMessagesFts excludes private threads by default', () => {
  const storage = setupStorage()
  storage.setThreadPrivacyMode({ threadId: 'thread-1', privacyMode: true, updatedAt: NOW })
  const results = storage.searchThreadsAndMessagesFts({ query: 'TypeScript' })
  assert.ok(!results.find((r) => r.threadId === 'thread-1'))
})

test('searchThreadsAndMessagesFts includes private threads when includePrivate is true', () => {
  const storage = setupStorage()
  storage.setThreadPrivacyMode({ threadId: 'thread-1', privacyMode: true, updatedAt: NOW })
  const results = storage.searchThreadsAndMessagesFts({
    query: 'TypeScript',
    includePrivate: true
  })
  assert.ok(results.find((r) => r.threadId === 'thread-1'))
})

test('excludes channel-group threads from title and message search', () => {
  const storage = setupStorage()
  storage.createThread({
    thread: makeThread({
      id: 'thread-group-probe',
      title: 'QQ群459936541 [group probe]',
      channelGroupId: 'group-1',
      updatedAt: NOW
    }),
    createdAt: NOW,
    messages: [
      makeMessage({
        id: 'probe-msg-1',
        threadId: 'thread-group-probe',
        content: 'TypeScript mentioned inside probe history',
        createdAt: NOW
      })
    ]
  })

  const byTitle = storage.searchThreadsAndMessages({ query: 'QQ' })
  assert.ok(!byTitle.find((r) => r.threadId === 'thread-group-probe'))

  const byContent = storage.searchThreadsAndMessages({ query: 'TypeScript' })
  assert.ok(!byContent.find((r) => r.threadId === 'thread-group-probe'))

  const byFts = storage.searchThreadsAndMessagesFts({ query: 'QQ' })
  assert.ok(!byFts.find((r) => r.threadId === 'thread-group-probe'))
})

test('each result has required fields', () => {
  const storage = setupStorage()
  const results = storage.searchThreadsAndMessages({ query: 'React' })
  for (const result of results) {
    assert.ok(typeof result.threadId === 'string')
    assert.ok(typeof result.threadTitle === 'string')
    assert.ok(typeof result.threadUpdatedAt === 'string')
    assert.ok(typeof result.titleMatched === 'boolean')
    assert.ok(Array.isArray(result.messageMatches))
  }
})
