import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  ActivitySourceRecord,
  MessageRecord,
  ThreadRecord
} from '../../../shared/yachiyo/protocol.ts'
import { createInMemoryYachiyoStorage } from './memoryStorage.ts'

const TIMESTAMP = '2026-04-28T00:00:00.000Z'

function makeThread(): ThreadRecord {
  return {
    id: 'thread-1',
    title: 'Thread',
    updatedAt: TIMESTAMP
  }
}

function makeRequestMessage(threadId: string): MessageRecord {
  return {
    id: 'msg-1',
    threadId,
    role: 'user',
    content: 'What changed?',
    status: 'completed',
    createdAt: TIMESTAMP
  }
}

function makeActivityRecord(input: {
  threadId: string
  runId: string
  requestMessageId: string
  id?: string
  startedAt?: string
}): ActivitySourceRecord {
  return {
    id: input.id ?? 'activity-1',
    threadId: input.threadId,
    runId: input.runId,
    requestMessageId: input.requestMessageId,
    startedAt: input.startedAt ?? TIMESTAMP,
    endedAt: '2026-04-28T00:00:01.000Z',
    totalDurationMs: 1_000,
    uniqueApps: 1,
    summaryText: 'ACTIVITY BLOCK',
    entries: [
      {
        appName: 'Browser',
        bundleId: 'com.example.browser',
        windowTitle: 'Issue tracker',
        durationMs: 1_000
      }
    ],
    createdAt: TIMESTAMP
  }
}

test('in-memory storage paginates activity source records in newest-first order', () => {
  const storage = createInMemoryYachiyoStorage()

  for (let index = 0; index < 5; index += 1) {
    storage.saveActivitySourceRecord(
      makeActivityRecord({
        id: `activity-${index}`,
        threadId: 'thread-1',
        runId: `run-${index}`,
        requestMessageId: `msg-${index}`,
        startedAt: `2026-04-28T00:00:0${index}.000Z`
      })
    )
  }

  const records = storage.listActivitySourceRecords({ offset: 2, limit: 2 })

  assert.equal(storage.countActivitySourceRecords(), 5)
  assert.deepEqual(
    records.map((record) => record.id),
    ['activity-2', 'activity-1']
  )
})

test('in-memory storage removes activity source records when thread history is reset', () => {
  const storage = createInMemoryYachiyoStorage()
  const thread = makeThread()
  const requestMessage = makeRequestMessage(thread.id)

  storage.createThread({ thread, createdAt: TIMESTAMP })
  storage.startRun({
    runId: 'run-1',
    thread,
    updatedThread: { ...thread, headMessageId: requestMessage.id },
    requestMessageId: requestMessage.id,
    userMessage: requestMessage,
    createdAt: TIMESTAMP
  })
  storage.saveActivitySourceRecord(
    makeActivityRecord({
      threadId: thread.id,
      runId: 'run-1',
      requestMessageId: requestMessage.id
    })
  )

  assert.equal(storage.listActivitySourceRecords().length, 1)

  storage.resetThreadHistory({ threadId: thread.id, updatedAt: '2026-04-28T00:00:02.000Z' })

  assert.deepEqual(storage.listActivitySourceRecords(), [])
})

test('in-memory storage removes activity source records when an owning run is deleted', () => {
  const storage = createInMemoryYachiyoStorage()
  const thread = makeThread()
  const requestMessage = makeRequestMessage(thread.id)

  storage.createThread({ thread, createdAt: TIMESTAMP })
  storage.startRun({
    runId: 'run-1',
    thread,
    updatedThread: { ...thread, headMessageId: requestMessage.id },
    requestMessageId: requestMessage.id,
    userMessage: requestMessage,
    createdAt: TIMESTAMP
  })
  storage.saveActivitySourceRecord(
    makeActivityRecord({
      threadId: thread.id,
      runId: 'run-1',
      requestMessageId: requestMessage.id
    })
  )

  assert.equal(storage.listActivitySourceRecords().length, 1)

  storage.deleteMessages({
    thread: { ...thread, headMessageId: undefined, updatedAt: '2026-04-28T00:00:02.000Z' },
    messageIds: [requestMessage.id]
  })

  assert.deepEqual(storage.listActivitySourceRecords(), [])
})
