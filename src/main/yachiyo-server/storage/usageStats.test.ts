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
    role: 'assistant',
    content: 'response',
    status: 'completed',
    createdAt: new Date().toISOString(),
    ...overrides
  }
}

function setupStorage(): ReturnType<typeof createInMemoryYachiyoStorage> {
  const storage = createInMemoryYachiyoStorage()

  // Thread in workspace A
  storage.createThread({
    thread: makeThread({ id: 't1', title: 'Thread A', workspacePath: '/projects/alpha' }),
    createdAt: '2026-04-10T00:00:00Z'
  })

  // Thread in workspace B
  storage.createThread({
    thread: makeThread({ id: 't2', title: 'Thread B', workspacePath: '/projects/beta' }),
    createdAt: '2026-04-10T00:00:00Z'
  })

  // Thread with no workspace
  storage.createThread({
    thread: makeThread({ id: 't3', title: 'Thread C' }),
    createdAt: '2026-04-10T00:00:00Z'
  })

  // Run 1: April 10, model-a, workspace alpha, with cache
  storage.startRun({
    runId: 'r1',
    thread: storage.getThread('t1')!,
    updatedThread: storage.getThread('t1')!,
    requestMessageId: undefined,
    createdAt: '2026-04-10T10:00:00Z'
  })
  storage.completeRun({
    runId: 'r1',
    updatedThread: { ...storage.getThread('t1')!, updatedAt: '2026-04-10T10:01:00Z' },
    assistantMessage: makeMessage({
      id: 'm1',
      threadId: 't1',
      modelId: 'model-a',
      providerName: 'openai'
    }),
    totalPromptTokens: 1000,
    totalCompletionTokens: 200,
    cacheReadTokens: 500,
    cacheWriteTokens: 100,
    modelId: 'model-a',
    providerName: 'openai'
  })

  // Run 2: April 10, model-b, workspace beta, no cache
  storage.startRun({
    runId: 'r2',
    thread: storage.getThread('t2')!,
    updatedThread: storage.getThread('t2')!,
    requestMessageId: undefined,
    createdAt: '2026-04-10T11:00:00Z'
  })
  storage.completeRun({
    runId: 'r2',
    updatedThread: { ...storage.getThread('t2')!, updatedAt: '2026-04-10T11:01:00Z' },
    assistantMessage: makeMessage({
      id: 'm2',
      threadId: 't2',
      modelId: 'model-b',
      providerName: 'anthropic'
    }),
    totalPromptTokens: 2000,
    totalCompletionTokens: 400,
    modelId: 'model-b',
    providerName: 'anthropic'
  })

  // Run 3: April 12, model-a, workspace alpha
  storage.startRun({
    runId: 'r3',
    thread: storage.getThread('t1')!,
    updatedThread: storage.getThread('t1')!,
    requestMessageId: undefined,
    createdAt: '2026-04-12T10:00:00Z'
  })
  storage.completeRun({
    runId: 'r3',
    updatedThread: { ...storage.getThread('t1')!, updatedAt: '2026-04-12T10:01:00Z' },
    assistantMessage: makeMessage({
      id: 'm3',
      threadId: 't1',
      modelId: 'model-a',
      providerName: 'openai'
    }),
    totalPromptTokens: 1500,
    totalCompletionTokens: 300,
    cacheReadTokens: 800,
    cacheWriteTokens: 200,
    modelId: 'model-a',
    providerName: 'openai'
  })

  // Run 4: April 12, model-a, no workspace
  storage.startRun({
    runId: 'r4',
    thread: storage.getThread('t3')!,
    updatedThread: storage.getThread('t3')!,
    requestMessageId: undefined,
    createdAt: '2026-04-12T14:00:00Z'
  })
  storage.completeRun({
    runId: 'r4',
    updatedThread: { ...storage.getThread('t3')!, updatedAt: '2026-04-12T14:01:00Z' },
    assistantMessage: makeMessage({
      id: 'm4',
      threadId: 't3',
      modelId: 'model-a',
      providerName: 'openai'
    }),
    totalPromptTokens: 500,
    totalCompletionTokens: 100,
    modelId: 'model-a',
    providerName: 'openai'
  })

  return storage
}

test('getUsageStats returns correct totals', () => {
  const storage = setupStorage()
  const stats = storage.getUsageStats({ period: 'day' })

  assert.equal(stats.totals.runCount, 4)
  assert.equal(stats.totals.promptTokens, 5000) // 1000 + 2000 + 1500 + 500
  assert.equal(stats.totals.completionTokens, 1000) // 200 + 400 + 300 + 100
  assert.equal(stats.totals.cacheReadTokens, 1300) // 500 + 0 + 800 + 0
  assert.equal(stats.totals.cacheWriteTokens, 300) // 100 + 0 + 200 + 0
})

test('getUsageStats groups by day correctly', () => {
  const storage = setupStorage()
  const stats = storage.getUsageStats({ period: 'day' })

  assert.equal(stats.buckets.length, 2) // April 10 and April 12
  assert.equal(stats.buckets[0].periodStart, '2026-04-10')
  assert.equal(stats.buckets[0].runCount, 2)
  assert.equal(stats.buckets[0].totalPromptTokens, 3000)
  assert.equal(stats.buckets[1].periodStart, '2026-04-12')
  assert.equal(stats.buckets[1].runCount, 2)
  assert.equal(stats.buckets[1].totalPromptTokens, 2000)
})

test('getUsageStats groups by month correctly', () => {
  const storage = setupStorage()
  const stats = storage.getUsageStats({ period: 'month' })

  assert.equal(stats.buckets.length, 1) // all in April 2026
  assert.equal(stats.buckets[0].periodStart, '2026-04')
  assert.equal(stats.buckets[0].runCount, 4)
})

test('getUsageStats groups by model correctly', () => {
  const storage = setupStorage()
  const stats = storage.getUsageStats({ period: 'day' })

  assert.equal(stats.byModel.length, 2)
  const modelA = stats.byModel.find((m) => m.modelId === 'model-a')!
  const modelB = stats.byModel.find((m) => m.modelId === 'model-b')!

  assert.equal(modelA.runCount, 3)
  assert.equal(modelA.totalPromptTokens, 3000) // 1000 + 1500 + 500
  assert.equal(modelA.providerName, 'openai')

  assert.equal(modelB.runCount, 1)
  assert.equal(modelB.totalPromptTokens, 2000)
  assert.equal(modelB.providerName, 'anthropic')
})

test('getUsageStats groups by workspace correctly', () => {
  const storage = setupStorage()
  const stats = storage.getUsageStats({ period: 'day' })

  assert.equal(stats.byWorkspace.length, 3)
  const alpha = stats.byWorkspace.find((w) => w.workspacePath === '/projects/alpha')!
  const beta = stats.byWorkspace.find((w) => w.workspacePath === '/projects/beta')!
  const noWs = stats.byWorkspace.find((w) => w.workspacePath === '__null__')!

  assert.equal(alpha.runCount, 2)
  assert.equal(alpha.totalPromptTokens, 2500) // 1000 + 1500
  assert.equal(beta.runCount, 1)
  assert.equal(beta.totalPromptTokens, 2000)
  assert.equal(noWs.runCount, 1)
  assert.equal(noWs.totalPromptTokens, 500)
})

test('getUsageStats filters by date range', () => {
  const storage = setupStorage()
  const stats = storage.getUsageStats({
    period: 'day',
    from: '2026-04-11T00:00:00Z',
    to: '2026-04-13T00:00:00Z'
  })

  assert.equal(stats.totals.runCount, 2) // only April 12 runs
  assert.equal(stats.buckets.length, 1)
  assert.equal(stats.buckets[0].periodStart, '2026-04-12')
})

test('getUsageStats filters by workspace', () => {
  const storage = setupStorage()
  const stats = storage.getUsageStats({ period: 'day', workspacePath: '/projects/alpha' })

  assert.equal(stats.totals.runCount, 2)
  assert.equal(stats.totals.promptTokens, 2500) // 1000 + 1500
})

test('getUsageStats filters by model', () => {
  const storage = setupStorage()
  const stats = storage.getUsageStats({ period: 'day', modelId: 'model-b' })

  assert.equal(stats.totals.runCount, 1)
  assert.equal(stats.totals.promptTokens, 2000)
  assert.equal(stats.byModel.length, 1)
  assert.equal(stats.byModel[0].modelId, 'model-b')
})

test('getUsageStats returns empty results when no data matches', () => {
  const storage = setupStorage()
  const stats = storage.getUsageStats({ period: 'day', from: '2030-01-01T00:00:00Z' })

  assert.equal(stats.totals.runCount, 0)
  assert.equal(stats.totals.promptTokens, 0)
  assert.equal(stats.buckets.length, 0)
  assert.equal(stats.byModel.length, 0)
  assert.equal(stats.byWorkspace.length, 0)
})

test('getUsageStats handles combined workspace + model filter', () => {
  const storage = setupStorage()
  const stats = storage.getUsageStats({
    period: 'day',
    workspacePath: '/projects/alpha',
    modelId: 'model-a'
  })

  assert.equal(stats.totals.runCount, 2)
  assert.equal(stats.totals.promptTokens, 2500) // 1000 + 1500
  assert.equal(stats.totals.cacheReadTokens, 1300) // 500 + 800
})

test('cacheAwarePromptTokens only counts runs with cache data', () => {
  const storage = setupStorage()
  const stats = storage.getUsageStats({ period: 'day' })

  // Runs r1 and r3 have cache data (promptTokens 1000 + 1500 = 2500)
  // Runs r2 and r4 have no cache data (promptTokens 2000 + 500 = 2500)
  // Total promptTokens = 5000, but cacheAwarePromptTokens = 2500
  assert.equal(stats.totals.promptTokens, 5000)
  assert.equal(stats.totals.cacheAwarePromptTokens, 2500)

  // Cache rate = 1300 / 2500 = 52%, NOT 1300 / 5000 = 26%
  // (verifying the denominator isn't polluted by non-cache runs)
})

test('cacheAwarePromptTokens is 0 when no runs have cache data', () => {
  const storage = setupStorage()
  // model-b runs have no cache data
  const stats = storage.getUsageStats({ period: 'day', modelId: 'model-b' })

  assert.equal(stats.totals.promptTokens, 2000)
  assert.equal(stats.totals.cacheAwarePromptTokens, 0)
  assert.equal(stats.totals.cacheReadTokens, 0)
})
