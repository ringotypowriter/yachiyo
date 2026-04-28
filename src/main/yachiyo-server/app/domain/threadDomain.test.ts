import assert from 'node:assert/strict'
import test from 'node:test'

import { withThreadCapabilities } from '../../../../shared/yachiyo/protocol.ts'
import { createInMemoryYachiyoStorage } from '../../storage/memoryStorage.ts'
import { YachiyoServerThreadDomain } from './threadDomain.ts'

function createThreadDomainHarness(
  runtimeBinding: {
    kind: 'acp'
    profileId: string
    profileName?: string
    sessionStatus: 'new' | 'active' | 'expired'
    sessionId?: string
    lastSessionBoundAt?: string
  } | null
): {
  domain: YachiyoServerThreadDomain
  events: Array<{ type: string; threadId?: string; thread?: { colorTag?: string } }>
  evictedThreadIds: string[]
  deletedWorkspaceThreadIds: string[]
  storage: ReturnType<typeof createInMemoryYachiyoStorage>
} {
  const storage = createInMemoryYachiyoStorage()
  const thread = withThreadCapabilities({
    id: 'thread-1',
    title: 'ACP thread',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(runtimeBinding ? { runtimeBinding } : {})
  })
  storage.createThread({
    thread,
    createdAt: '2026-01-01T00:00:00.000Z',
    messages: []
  })

  const evictedThreadIds: string[] = []
  const deletedWorkspaceThreadIds: string[] = []
  const events: Array<{ type: string; threadId?: string; thread?: { colorTag?: string } }> = []
  const domain = new YachiyoServerThreadDomain({
    storage,
    createId: () => 'id-1',
    timestamp: () => '2026-01-01T00:00:01.000Z',
    emit: (event) => {
      events.push(event)
    },
    ensureThreadWorkspace: async () => '/tmp/thread-1',
    cloneThreadWorkspace: async () => '/tmp/thread-1',
    deleteThreadWorkspace: async (threadId) => {
      deletedWorkspaceThreadIds.push(threadId)
    },
    memoryService: { isConfigured: () => false } as never,
    loadThreadMessages: () => [],
    requireThread: (threadId) => {
      const stored = storage.getThread(threadId)
      if (!stored) throw new Error(`Unknown thread: ${threadId}`)
      return stored
    },
    isThreadRunning: () => false,
    auxiliaryGeneration: {} as never,
    evictAcpIdleThread: async (threadId) => {
      evictedThreadIds.push(threadId)
    }
  })

  return { domain, events, evictedThreadIds, deletedWorkspaceThreadIds, storage }
}

test('YachiyoServerThreadDomain sets and clears a thread title color', () => {
  const { domain, events, storage } = createThreadDomainHarness(null)

  const coloredThread = domain.setThreadColor({ threadId: 'thread-1', colorTag: 'azure' })

  assert.equal(coloredThread.colorTag, 'azure')
  assert.equal(coloredThread.updatedAt, '2026-01-01T00:00:01.000Z')
  assert.equal(storage.getThread('thread-1')?.colorTag, 'azure')
  assert.deepEqual(events.at(-1), {
    type: 'thread.updated',
    threadId: 'thread-1',
    thread: coloredThread
  })

  const defaultThread = domain.setThreadColor({ threadId: 'thread-1', colorTag: null })

  assert.equal(defaultThread.colorTag, undefined)
  assert.equal(storage.getThread('thread-1')?.colorTag, undefined)
  assert.deepEqual(events.at(-1), {
    type: 'thread.updated',
    threadId: 'thread-1',
    thread: defaultThread
  })
})

test('YachiyoServerThreadDomain archives ACP threads only after evicting idle sessions', async () => {
  const { domain, evictedThreadIds, storage } = createThreadDomainHarness({
    kind: 'acp',
    profileId: 'agent-1',
    profileName: 'ACP Agent',
    sessionStatus: 'active',
    sessionId: 'session-1'
  })

  await domain.archiveThread({ threadId: 'thread-1' })

  assert.deepEqual(evictedThreadIds, ['thread-1'])
  assert.equal(storage.getThread('thread-1'), undefined)
  assert.equal(storage.getArchivedThread('thread-1')?.id, 'thread-1')
})

test('YachiyoServerThreadDomain deletes ACP threads only after evicting idle sessions', async () => {
  const { domain, evictedThreadIds, deletedWorkspaceThreadIds, storage } =
    createThreadDomainHarness({
      kind: 'acp',
      profileId: 'agent-1',
      profileName: 'ACP Agent',
      sessionStatus: 'active',
      sessionId: 'session-1'
    })

  await domain.deleteThread({ threadId: 'thread-1' })

  assert.deepEqual(evictedThreadIds, ['thread-1'])
  assert.deepEqual(deletedWorkspaceThreadIds, ['thread-1'])
  assert.equal(storage.getThread('thread-1'), undefined)
  assert.equal(storage.getArchivedThread('thread-1'), undefined)
})
