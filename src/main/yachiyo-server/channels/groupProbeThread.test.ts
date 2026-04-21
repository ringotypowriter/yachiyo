import assert from 'node:assert/strict'
import test from 'node:test'

import type { ChannelGroupRecord, ThreadRecord } from '../../../shared/yachiyo/protocol.ts'
import { withThreadCapabilities } from '../../../shared/yachiyo/protocol.ts'
import { createInMemoryYachiyoStorage } from '../storage/memoryStorage.ts'
import { persistSuccessfulGroupProbeTurn, resolveGroupProbeThread } from './groupProbeThread.ts'

function makeThread(id: string, overrides: Partial<ThreadRecord> = {}): ThreadRecord {
  return withThreadCapabilities({
    id,
    title: 'Group Probe',
    updatedAt: '2026-04-21T00:00:00.000Z',
    source: 'telegram' as const,
    channelGroupId: 'group-1',
    ...overrides
  }) as ThreadRecord
}

function makeGroup(overrides: Partial<ChannelGroupRecord> = {}): ChannelGroupRecord {
  return {
    id: 'group-1',
    platform: 'telegram',
    externalGroupId: 'ext-group-1',
    name: 'Test Group',
    label: 'Test Group',
    status: 'approved',
    workspacePath: '/tmp/group-workspace',
    createdAt: '2026-04-21T00:00:00.000Z',
    ...overrides
  } as ChannelGroupRecord
}

test('resolveGroupProbeThread creates and reuses hidden group threads', async () => {
  const created: Array<Record<string, unknown>> = []
  const createdThread = makeThread('thread-new')

  const result = await resolveGroupProbeThread({
    logLabel: 'group-probe',
    server: {
      findActiveGroupThread: () => undefined,
      createThread: async (input) => {
        created.push(input)
        return createdThread
      },
      setThreadModelOverride: async () => {
        throw new Error('setThreadModelOverride should not be called')
      },
      getThreadTotalTokens: () => 0,
      compactExternalThread: async () => {
        throw new Error('compactExternalThread should not be called')
      }
    },
    group: makeGroup(),
    groupThreadReuseWindowMs: 7 * 24 * 60 * 60 * 1_000,
    contextTokenLimit: 64_000
  })

  assert.equal(result.compacted, false)
  assert.equal(result.thread.id, 'thread-new')
  assert.equal(created.length, 1)
  assert.equal(created[0]?.channelGroupId, 'group-1')
  assert.equal(created[0]?.source, 'telegram')
  assert.equal(created[0]?.workspacePath, '/tmp/group-workspace')
})

test('resolveGroupProbeThread compacts before the next probe can cross the token limit', async () => {
  const existingThread = makeThread('thread-existing')
  const compactedThread = makeThread('thread-existing', {
    rollingSummary: 'rolling summary',
    summaryWatermarkMessageId: 'msg-watermark'
  })
  const compactCalls: string[] = []

  const result = await resolveGroupProbeThread({
    logLabel: 'group-probe',
    server: {
      findActiveGroupThread: () => existingThread,
      createThread: async () => {
        throw new Error('createThread should not be called')
      },
      setThreadModelOverride: async () => {
        throw new Error('setThreadModelOverride should not be called')
      },
      getThreadTotalTokens: () => 62_500,
      compactExternalThread: async ({ threadId }) => {
        compactCalls.push(threadId)
        return { thread: compactedThread }
      }
    },
    group: makeGroup(),
    groupThreadReuseWindowMs: 7 * 24 * 60 * 60 * 1_000,
    contextTokenLimit: 64_000
  })

  assert.equal(result.compacted, true)
  assert.equal(result.thread.rollingSummary, 'rolling summary')
  assert.deepEqual(compactCalls, ['thread-existing'])
})

test('persistSuccessfulGroupProbeTurn stores hidden request/assistant messages and completed run', () => {
  const storage = createInMemoryYachiyoStorage()
  const thread = makeThread('thread-1')
  storage.createThread({ thread, createdAt: '2026-04-21T00:00:00.000Z' })

  const updatedThread = persistSuccessfulGroupProbeTurn({
    storage,
    generateId: (() => {
      const ids = ['msg-user', 'run-1', 'msg-assistant']
      return () => ids.shift() ?? 'unexpected'
    })(),
    thread,
    requestContent: '<msg from="Alice">hello</msg>',
    result: {
      status: 'success',
      settings: {
        providerName: 'tool-model',
        provider: 'openai',
        model: 'gpt-4.1',
        apiKey: 'sk-test',
        baseUrl: ''
      },
      text: 'I should jump in with one short reply.',
      usage: {
        promptTokens: 321,
        completionTokens: 45,
        totalPromptTokens: 321,
        totalCompletionTokens: 45,
        responseMessages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'I should jump in with one short reply.' }]
          }
        ]
      }
    },
    requestAt: '2026-04-21T00:00:01.000Z',
    assistantAt: '2026-04-21T00:00:02.000Z'
  })

  const messages = storage.listThreadMessages(thread.id)
  const runs = storage.listThreadRuns(thread.id)

  assert.equal(updatedThread.headMessageId, 'msg-assistant')
  assert.equal(messages.length, 2)
  assert.equal(messages[0]?.role, 'user')
  assert.equal(messages[0]?.hidden, true)
  assert.equal(messages[0]?.content, '<msg from="Alice">hello</msg>')
  assert.equal(messages[1]?.role, 'assistant')
  assert.equal(messages[1]?.hidden, true)
  assert.equal(messages[1]?.content, 'I should jump in with one short reply.')
  assert.deepEqual(messages[1]?.responseMessages, [
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'I should jump in with one short reply.' }]
    }
  ])
  assert.equal(runs.length, 1)
  assert.equal(runs[0]?.status, 'completed')
  assert.equal(storage.getThreadTotalTokens(thread.id), 321)
})

test('persistSuccessfulGroupProbeTurn rebases on the live thread head after history reset', () => {
  const storage = createInMemoryYachiyoStorage()
  const thread = makeThread('thread-1')
  storage.createThread({ thread, createdAt: '2026-04-21T00:00:00.000Z' })

  const staleThread = persistSuccessfulGroupProbeTurn({
    storage,
    generateId: (() => {
      const ids = ['msg-user-old', 'run-old', 'msg-assistant-old']
      return () => ids.shift() ?? 'unexpected-old'
    })(),
    thread,
    requestContent: '<msg from="Alice">before clear</msg>',
    result: {
      status: 'success',
      settings: {
        providerName: 'tool-model',
        provider: 'openai',
        model: 'gpt-4.1',
        apiKey: 'sk-test',
        baseUrl: ''
      },
      text: 'Old monologue.',
      usage: {
        promptTokens: 100,
        completionTokens: 10,
        totalPromptTokens: 100,
        totalCompletionTokens: 10
      }
    },
    requestAt: '2026-04-21T00:00:01.000Z',
    assistantAt: '2026-04-21T00:00:02.000Z'
  })

  storage.resetThreadHistory({
    threadId: thread.id,
    updatedAt: '2026-04-21T00:01:00.000Z'
  })

  persistSuccessfulGroupProbeTurn({
    storage,
    generateId: (() => {
      const ids = ['msg-user-new', 'run-new', 'msg-assistant-new']
      return () => ids.shift() ?? 'unexpected-new'
    })(),
    thread: staleThread,
    requestContent: '<msg from="Bob">after clear</msg>',
    result: {
      status: 'success',
      settings: {
        providerName: 'tool-model',
        provider: 'openai',
        model: 'gpt-4.1',
        apiKey: 'sk-test',
        baseUrl: ''
      },
      text: 'Fresh monologue.',
      usage: {
        promptTokens: 120,
        completionTokens: 12,
        totalPromptTokens: 120,
        totalCompletionTokens: 12
      }
    },
    requestAt: '2026-04-21T00:01:01.000Z',
    assistantAt: '2026-04-21T00:01:02.000Z'
  })

  const messages = storage.listThreadMessages(thread.id)
  assert.equal(messages.length, 2)
  assert.equal(messages[0]?.id, 'msg-user-new')
  assert.equal(messages[0]?.parentMessageId, undefined)
  assert.equal(messages[1]?.id, 'msg-assistant-new')
  assert.equal(messages[1]?.parentMessageId, 'msg-user-new')
})

test('listExternalThreads excludes hidden group probe threads', () => {
  const storage = createInMemoryYachiyoStorage()

  storage.createThread({
    thread: withThreadCapabilities({
      id: 'dm-thread',
      title: 'Owner DM',
      updatedAt: '2026-04-21T00:00:00.000Z',
      source: 'telegram' as const,
      channelUserId: 'user-1'
    }) as ThreadRecord,
    createdAt: '2026-04-21T00:00:00.000Z'
  })
  storage.createThread({
    thread: makeThread('group-thread'),
    createdAt: '2026-04-21T00:00:00.000Z'
  })

  assert.deepEqual(
    storage.listExternalThreads().map((thread) => thread.id),
    ['dm-thread']
  )
})
