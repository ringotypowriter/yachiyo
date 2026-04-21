import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  MessageRecord,
  SettingsConfig,
  ThreadRecord
} from '../../../../shared/yachiyo/protocol.ts'
import type { MemoryService, SaveThreadMemoryInput } from './memoryService.ts'
import { createMemoryDistillationScheduler } from './memoryDistillationScheduler.ts'

function makeThread(id: string, headMessageId?: string): ThreadRecord {
  return {
    id,
    title: `Thread ${id}`,
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...(headMessageId ? { headMessageId } : {})
  }
}

function makeMessages(threadId: string, count: number = 2): MessageRecord[] {
  const messages: MessageRecord[] = []
  for (let i = 0; i < count; i++) {
    const id = `msg-${i + 1}`
    const msg: MessageRecord = {
      id,
      threadId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${i + 1}`,
      status: 'completed',
      createdAt: `2026-04-01T00:00:0${i}.000Z`,
      ...(i > 0 ? { parentMessageId: `msg-${i}` } : {})
    }
    messages.push(msg)
  }
  return messages
}

interface StubMemoryService extends MemoryService {
  saveThreadCalls: Array<{ threadId: string; messageIds: string[] }>
}

function createStubMemoryService(): StubMemoryService {
  const saveThreadCalls: Array<{ threadId: string; messageIds: string[] }> = []
  return {
    saveThreadCalls,
    isConfigured: () => true,
    hasHiddenSearchCapability: () => false,
    async searchMemories() {
      return []
    },
    async testConnection() {
      return { ok: true, message: 'ok' }
    },
    async recallForContext(input) {
      return {
        decision: {
          shouldRecall: false,
          reasons: [],
          score: 0,
          messagesSinceLastRecall: 0,
          charsSinceLastRecall: 0,
          idleMs: 0,
          noveltyScore: 0,
          novelTerms: []
        },
        entries: [],
        thread: input.thread
      }
    },
    async createMemory() {
      return { savedCount: 0 }
    },
    async validateAndCreateMemory() {
      return { savedCount: 0 }
    },
    async distillCompletedRun() {
      return { savedCount: 0 }
    },
    async saveThread(input: SaveThreadMemoryInput) {
      saveThreadCalls.push({
        threadId: input.thread.id,
        messageIds: input.messages.map((m) => m.id)
      })
      return { savedCount: 1 }
    }
  }
}

function createDeps(overrides?: {
  memoryService?: StubMemoryService
  config?: SettingsConfig
  messages?: Map<string, MessageRecord[]>
  threads?: Map<string, ThreadRecord>
  tokens?: Map<string, number>
}): {
  memoryService: StubMemoryService
  deps: Parameters<typeof createMemoryDistillationScheduler>[0]
} {
  const memoryService = overrides?.memoryService ?? createStubMemoryService()
  const config: SettingsConfig = overrides?.config ?? { providers: [] }
  const messagesMap = overrides?.messages ?? new Map<string, MessageRecord[]>()
  const threadsMap = overrides?.threads ?? new Map<string, ThreadRecord>()
  const tokensMap = overrides?.tokens ?? new Map<string, number>()
  return {
    memoryService,
    deps: {
      memoryService,
      readConfig: () => config,
      loadThreadMessages: (threadId) => messagesMap.get(threadId) ?? makeMessages(threadId),
      getThread: (threadId) => threadsMap.get(threadId) ?? makeThread(threadId),
      getThreadTotalTokens: (threadId) => tokensMap.get(threadId) ?? 16_000
    }
  }
}

test('scheduler debounces distillation — does not fire immediately and drops on close', async () => {
  const { memoryService, deps } = createDeps()
  const scheduler = createMemoryDistillationScheduler(deps)

  scheduler.onRunCompleted(makeThread('t1'))

  // Not yet — debounce is 10 minutes
  assert.equal(memoryService.saveThreadCalls.length, 0)

  // Close drops pending entries that haven't reached the debounce/threshold gate
  await scheduler.close()
  assert.equal(memoryService.saveThreadCalls.length, 0)
})

test('scheduler resets timer on subsequent runs and drops pending on close', async () => {
  const { memoryService, deps } = createDeps()
  const scheduler = createMemoryDistillationScheduler(deps)

  scheduler.onRunCompleted(makeThread('t1'))
  scheduler.onRunCompleted(makeThread('t1'))
  scheduler.onRunCompleted(makeThread('t1'))

  assert.equal(memoryService.saveThreadCalls.length, 0)

  // Pending entries below threshold are dropped on close
  await scheduler.close()
  assert.equal(memoryService.saveThreadCalls.length, 0)
})

test('scheduler force-flushes at run threshold (8 runs)', async () => {
  const { memoryService, deps } = createDeps()
  const scheduler = createMemoryDistillationScheduler(deps)

  const thread = makeThread('t1')
  for (let i = 0; i < 8; i++) {
    scheduler.onRunCompleted(thread)
  }

  // Wait a tick for the async flush to complete
  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(memoryService.saveThreadCalls.length, 1)
  assert.equal(memoryService.saveThreadCalls[0]!.threadId, 't1')

  await scheduler.close()
})

test('scheduler does not flush when auto distillation is disabled', async () => {
  const { memoryService, deps } = createDeps({
    config: { providers: [], chat: { autoMemoryDistillation: false } }
  })
  const scheduler = createMemoryDistillationScheduler(deps)

  const thread = makeThread('t1')
  for (let i = 0; i < 10; i++) {
    scheduler.onRunCompleted(thread)
  }

  assert.equal(memoryService.saveThreadCalls.length, 0)

  await scheduler.close()
  assert.equal(memoryService.saveThreadCalls.length, 0)
})

test('scheduler skips privacy-mode and external-source threads', async () => {
  const { memoryService, deps } = createDeps()
  const scheduler = createMemoryDistillationScheduler(deps)

  const privacyThread: ThreadRecord = { ...makeThread('t1'), privacyMode: true }
  const externalThread: ThreadRecord = { ...makeThread('t2'), source: 'telegram' }

  for (let i = 0; i < 10; i++) {
    scheduler.onRunCompleted(privacyThread)
    scheduler.onRunCompleted(externalThread)
  }

  assert.equal(memoryService.saveThreadCalls.length, 0)

  await scheduler.close()
  assert.equal(memoryService.saveThreadCalls.length, 0)
})

test('cancelThread clears pending timer so close does not flush it', async () => {
  const { memoryService, deps } = createDeps()
  const scheduler = createMemoryDistillationScheduler(deps)

  scheduler.onRunCompleted(makeThread('t1'))
  scheduler.cancelThread('t1')

  await scheduler.close()
  assert.equal(memoryService.saveThreadCalls.length, 0)
})

test('scheduler tracks independent threads separately', async () => {
  const { memoryService, deps } = createDeps()
  const scheduler = createMemoryDistillationScheduler(deps)

  // Thread t1 hits threshold → immediate flush
  for (let i = 0; i < 8; i++) {
    scheduler.onRunCompleted(makeThread('t1'))
  }

  // Thread t2 does not hit threshold
  scheduler.onRunCompleted(makeThread('t2'))

  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(memoryService.saveThreadCalls.length, 1)
  assert.equal(memoryService.saveThreadCalls[0]!.threadId, 't1')

  // t2 is below threshold and is dropped on close
  await scheduler.close()
  assert.equal(memoryService.saveThreadCalls.length, 1)
})

test('scheduler resets run counter after threshold flush', async () => {
  const { memoryService, deps } = createDeps()
  const scheduler = createMemoryDistillationScheduler(deps)

  const thread = makeThread('t1')
  // First batch of 8 → flush
  for (let i = 0; i < 8; i++) {
    scheduler.onRunCompleted(thread)
  }

  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(memoryService.saveThreadCalls.length, 1)

  // After flush, 3 more runs should not trigger another flush
  for (let i = 0; i < 3; i++) {
    scheduler.onRunCompleted(thread)
  }

  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(memoryService.saveThreadCalls.length, 1)

  // Those 3 pending runs are dropped on close (below threshold)
  await scheduler.close()
  assert.equal(memoryService.saveThreadCalls.length, 1)
})

test('scheduler skips empty message threads', async () => {
  const emptyMessages = new Map<string, MessageRecord[]>()
  emptyMessages.set('t1', [])
  const { memoryService, deps } = createDeps({ messages: emptyMessages })
  const scheduler = createMemoryDistillationScheduler(deps)

  const thread = makeThread('t1')
  for (let i = 0; i < 8; i++) {
    scheduler.onRunCompleted(thread)
  }

  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(memoryService.saveThreadCalls.length, 0)

  await scheduler.close()
})

test('scheduler skips threads with too few prompt tokens', async () => {
  const { memoryService, deps } = createDeps({
    tokens: new Map([['t1', 10_000]])
  })
  const scheduler = createMemoryDistillationScheduler(deps)

  const thread = makeThread('t1')
  for (let i = 0; i < 8; i++) {
    scheduler.onRunCompleted(thread)
  }

  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(memoryService.saveThreadCalls.length, 0)

  await scheduler.close()
})

test('scheduler filters messages to the canonical branch using headMessageId', async () => {
  const threadId = 't-branch'
  // Branched thread: msg-1 → msg-2a (abandoned) and msg-1 → msg-2b → msg-3b → msg-4b (canonical)
  const branchedMessages: MessageRecord[] = [
    {
      id: 'msg-1',
      threadId,
      role: 'user',
      content: 'Original question',
      status: 'completed',
      createdAt: '2026-04-01T00:00:00.000Z'
    },
    {
      id: 'msg-2a',
      threadId,
      role: 'assistant',
      content: 'Abandoned branch response',
      status: 'completed',
      createdAt: '2026-04-01T00:00:01.000Z',
      parentMessageId: 'msg-1'
    },
    {
      id: 'msg-2b',
      threadId,
      role: 'assistant',
      content: 'Canonical branch response',
      status: 'completed',
      createdAt: '2026-04-01T00:00:02.000Z',
      parentMessageId: 'msg-1'
    },
    {
      id: 'msg-3b',
      threadId,
      role: 'user',
      content: 'Canonical follow-up',
      status: 'completed',
      createdAt: '2026-04-01T00:00:03.000Z',
      parentMessageId: 'msg-2b'
    },
    {
      id: 'msg-4b',
      threadId,
      role: 'assistant',
      content: 'Canonical follow-up response',
      status: 'completed',
      createdAt: '2026-04-01T00:00:04.000Z',
      parentMessageId: 'msg-3b'
    }
  ]

  const messages = new Map<string, MessageRecord[]>()
  messages.set(threadId, branchedMessages)
  const thread = makeThread(threadId, 'msg-4b')
  const threads = new Map<string, ThreadRecord>()
  threads.set(threadId, thread)
  const { memoryService, deps } = createDeps({ messages, threads })
  const scheduler = createMemoryDistillationScheduler(deps)
  for (let i = 0; i < 8; i++) {
    scheduler.onRunCompleted(thread)
  }

  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(memoryService.saveThreadCalls.length, 1)
  // Only the canonical path (msg-1 → msg-2b → msg-3b → msg-4b), not the abandoned msg-2a
  assert.deepEqual(memoryService.saveThreadCalls[0]!.messageIds, [
    'msg-1',
    'msg-2b',
    'msg-3b',
    'msg-4b'
  ])

  await scheduler.close()
})

test('scheduler reads current thread at flush time, not the stale snapshot', async () => {
  const threadId = 't-switch'
  const branchedMessages: MessageRecord[] = [
    {
      id: 'msg-1',
      threadId,
      role: 'user',
      content: 'Question',
      status: 'completed',
      createdAt: '2026-04-01T00:00:00.000Z'
    },
    {
      id: 'msg-2a',
      threadId,
      role: 'assistant',
      content: 'Old branch',
      status: 'completed',
      createdAt: '2026-04-01T00:00:01.000Z',
      parentMessageId: 'msg-1'
    },
    {
      id: 'msg-2b',
      threadId,
      role: 'assistant',
      content: 'New branch',
      status: 'completed',
      createdAt: '2026-04-01T00:00:02.000Z',
      parentMessageId: 'msg-1'
    },
    {
      id: 'msg-3b',
      threadId,
      role: 'user',
      content: 'New branch follow-up',
      status: 'completed',
      createdAt: '2026-04-01T00:00:03.000Z',
      parentMessageId: 'msg-2b'
    },
    {
      id: 'msg-4b',
      threadId,
      role: 'assistant',
      content: 'New branch follow-up response',
      status: 'completed',
      createdAt: '2026-04-01T00:00:04.000Z',
      parentMessageId: 'msg-3b'
    }
  ]

  const messages = new Map<string, MessageRecord[]>()
  messages.set(threadId, branchedMessages)
  // Initially the thread points to the old branch
  const threads = new Map<string, ThreadRecord>()
  threads.set(threadId, makeThread(threadId, 'msg-2a'))
  const { memoryService, deps } = createDeps({ messages, threads })
  const scheduler = createMemoryDistillationScheduler(deps)

  // Queue runs with the old headMessageId
  const oldThread = makeThread(threadId, 'msg-2a')
  for (let i = 0; i < 7; i++) {
    scheduler.onRunCompleted(oldThread)
  }

  // User switches branch during debounce window
  threads.set(threadId, makeThread(threadId, 'msg-4b'))

  // 8th run triggers threshold flush — should read the updated thread
  scheduler.onRunCompleted(oldThread)

  await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(memoryService.saveThreadCalls.length, 1)
  // Should follow the NEW branch (msg-1 → msg-2b → msg-3b → msg-4b), not the old one
  assert.deepEqual(memoryService.saveThreadCalls[0]!.messageIds, [
    'msg-1',
    'msg-2b',
    'msg-3b',
    'msg-4b'
  ])

  await scheduler.close()
})

test('scheduler skips distillation when all runs in the batch used the remember tool', async () => {
  const { memoryService, deps } = createDeps()
  const scheduler = createMemoryDistillationScheduler(deps)

  const thread = makeThread('t1')
  for (let i = 0; i < 8; i++) {
    scheduler.onRunCompleted(thread, true) // all runs used remember tool
  }

  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(memoryService.saveThreadCalls.length, 0)

  await scheduler.close()
  assert.equal(memoryService.saveThreadCalls.length, 0)
})

test('scheduler still distills when only some runs used the remember tool', async () => {
  const { memoryService, deps } = createDeps()
  const scheduler = createMemoryDistillationScheduler(deps)

  const thread = makeThread('t1')
  // 5 runs with remember, 3 without → mixed batch
  for (let i = 0; i < 5; i++) {
    scheduler.onRunCompleted(thread, true)
  }
  for (let i = 0; i < 3; i++) {
    scheduler.onRunCompleted(thread, false)
  }

  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(memoryService.saveThreadCalls.length, 1)

  await scheduler.close()
})

test('cancelThread aborts an already-started distillation task', async () => {
  const abortedSignals: boolean[] = []
  const memoryService = createStubMemoryService()
  // Override saveThread with a slow version that checks the signal
  memoryService.saveThread = async (input: SaveThreadMemoryInput) => {
    await new Promise((resolve) => setTimeout(resolve, 200))
    abortedSignals.push(input.signal?.aborted ?? false)
    return { savedCount: 0 }
  }

  const { deps } = createDeps({ memoryService })
  const scheduler = createMemoryDistillationScheduler(deps)

  // Hit threshold to start the distillation task
  const thread = makeThread('t1')
  for (let i = 0; i < 8; i++) {
    scheduler.onRunCompleted(thread)
  }

  // Give the flush a moment to start the async task
  await new Promise((resolve) => setTimeout(resolve, 10))

  // Cancel while the task is in-flight
  scheduler.cancelThread('t1')

  // Wait for the task to observe the abort
  await new Promise((resolve) => setTimeout(resolve, 250))

  // The signal should have been aborted
  assert.equal(abortedSignals.length, 1)
  assert.equal(abortedSignals[0], true)

  await scheduler.close()
})

test('close drops sub-threshold entries but awaits already-started tasks', async () => {
  const { memoryService, deps } = createDeps()
  const scheduler = createMemoryDistillationScheduler(deps)

  // Thread t1 hits threshold → starts an active task
  const thread = makeThread('t1')
  for (let i = 0; i < 8; i++) {
    scheduler.onRunCompleted(thread)
  }

  // Thread t2 is below threshold
  scheduler.onRunCompleted(makeThread('t2'))

  await scheduler.close()

  // t1 was already flushed by threshold; t2 was dropped
  assert.equal(memoryService.saveThreadCalls.length, 1)
  assert.equal(memoryService.saveThreadCalls[0]!.threadId, 't1')
})
