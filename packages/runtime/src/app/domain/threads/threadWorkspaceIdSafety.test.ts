import assert from 'node:assert/strict'
import test from 'node:test'

import { withThreadCapabilities } from '@yachiyo/shared/protocol'
import { resolveThreadWorkspacePath } from '../../../config/paths.ts'
import { createInMemoryYachiyoStorage } from '../../../storage/memoryStorage.ts'
import { YachiyoServerThreadDomain } from './threadDomain.ts'

/**
 * The real path resolver, not a stub: this file exists to check what the
 * validator it now performs does to the callers around it.
 */
function createDomainWithRealPathResolution(thread: { id: string; workspacePath?: string }): {
  domain: YachiyoServerThreadDomain
  deletedWorkspaceThreadIds: string[]
} {
  const storage = createInMemoryYachiyoStorage()
  storage.createThread({
    thread: withThreadCapabilities({
      id: thread.id,
      title: 'Thread',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...(thread.workspacePath ? { workspacePath: thread.workspacePath } : {})
    }),
    createdAt: '2026-01-01T00:00:00.000Z',
    messages: []
  })
  const deletedWorkspaceThreadIds: string[] = []
  const domain = new YachiyoServerThreadDomain({
    storage,
    createId: () => 'id-1',
    timestamp: () => '2026-01-01T00:00:01.000Z',
    emit: () => {},
    resolveThreadWorkspacePath,
    ensureThreadWorkspace: async (threadId) => resolveThreadWorkspacePath(threadId),
    cloneThreadWorkspace: async (threadId) => resolveThreadWorkspacePath(threadId),
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
    loadThreadToolCalls: (threadId) => storage.listThreadToolCalls(threadId),
    isThreadRunning: () => false,
    auxiliaryGeneration: {} as never,
    evictAcpIdleThread: async () => {},
    closeSubagentsForThread: async () => {}
  })
  return { domain, deletedWorkspaceThreadIds }
}

test('deleting a thread whose workspace path has no usable owner still succeeds', async () => {
  // The delete path asks "is this a temporary workspace?" by taking the
  // basename as a thread id. A root-ish path yields an empty basename, which
  // the new validator refuses — but that question has to answer "no", not
  // throw, or one odd row makes its own thread undeletable.
  const { domain, deletedWorkspaceThreadIds } = createDomainWithRealPathResolution({
    id: 'thread-1',
    workspacePath: '/'
  })

  await domain.deleteThread({ threadId: 'thread-1' })

  assert.deepEqual(deletedWorkspaceThreadIds, [])
})

test('a thread whose id cannot be a path fails only its own workspace work', async () => {
  // A peer can put any string in a thread row's id; sync does not check it.
  // The row is allowed to exist locally, so ordinary reads must keep working —
  // only deriving a workspace path from it is refused.
  const traversingId = '../escape'
  const { domain } = createDomainWithRealPathResolution({ id: traversingId })

  assert.throws(() => resolveThreadWorkspacePath(traversingId), /thread id/i)
  await assert.rejects(() => domain.deleteThread({ threadId: traversingId }), /thread id/i)
})

test('creating a thread with an unusable explicit id is refused up front', async () => {
  // Nothing in production passes an explicit id today; this keeps a future
  // import surface from reaching the path derivation with a bad one.
  const { domain } = createDomainWithRealPathResolution({ id: 'thread-1' })

  await assert.rejects(() => domain.createThread({ threadId: '../escape' }), /thread id/i)
  await assert.rejects(() => domain.createThread({ threadId: '' }), /thread id/i)
})

test('creating a thread with an ordinary explicit id still works', async () => {
  const { domain } = createDomainWithRealPathResolution({ id: 'thread-1' })

  const created = await domain.createThread({ threadId: 'legacy_thread_2' })

  assert.equal(created.id, 'legacy_thread_2')
})
