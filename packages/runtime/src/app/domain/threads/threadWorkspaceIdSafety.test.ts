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
function createDomainWithRealPathResolution(
  thread: { id: string; workspacePath?: string },
  resolvePath: (threadId: string) => string = resolveThreadWorkspacePath
): {
  domain: YachiyoServerThreadDomain
  deletedWorkspaceThreadIds: string[]
  storage: ReturnType<typeof createInMemoryYachiyoStorage>
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
    resolveThreadWorkspacePath: resolvePath,
    ensureThreadWorkspace: async (threadId) => resolvePath(threadId),
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
  return { domain, deletedWorkspaceThreadIds, storage }
}

test('deleting a thread whose workspace path has no usable owner still succeeds', async () => {
  // The delete path asks "is this a temporary workspace?" by taking the
  // basename as a thread id. A root-ish path yields an empty basename, which
  // the new validator refuses — but that question has to answer "no", not
  // throw, or one odd row makes its own thread undeletable.
  const { domain, deletedWorkspaceThreadIds, storage } = createDomainWithRealPathResolution({
    id: 'thread-1',
    workspacePath: '/'
  })

  await domain.deleteThread({ threadId: 'thread-1' })

  // Both halves: no workspace was deleted, and the thread itself actually
  // went. Asserting only the first would pass just as well if deleteThread
  // had bailed out early and done nothing at all.
  assert.deepEqual(deletedWorkspaceThreadIds, [])
  assert.equal(storage.getThread('thread-1'), undefined)
})

test('a thread whose id cannot be a path fails only its own workspace work', async () => {
  // A peer can put any string in a thread row's id; sync does not check it.
  // The row is allowed to exist locally, so ordinary reads must keep working —
  // only deriving a workspace path from it is refused.
  const traversingId = '../escape'
  const { domain, storage } = createDomainWithRealPathResolution({ id: traversingId })

  assert.throws(() => resolveThreadWorkspacePath(traversingId), /thread id/i)
  await assert.rejects(() => domain.deleteThread({ threadId: traversingId }), /thread id/i)

  // The half that matters more than the refusal: everything that does not
  // derive a path still works, so one malformed row cannot take the app down
  // with it.
  assert.equal(storage.getThread(traversingId)?.id, traversingId)
  assert.equal(
    domain.setThreadColor({ threadId: traversingId, colorTag: 'azure' }).colorTag,
    'azure'
  )
  assert.equal(storage.listThreadMessages(traversingId).length, 0)

  // And a normal thread sitting beside it is untouched: the refusal is scoped
  // to the row that cannot name a path, not to the workspace machinery.
  storage.createThread({
    thread: withThreadCapabilities({
      id: 'healthy-thread',
      title: 'Healthy',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }),
    createdAt: '2026-01-01T00:00:00.000Z',
    messages: []
  })
  assert.equal(resolveThreadWorkspacePath('healthy-thread').endsWith('healthy-thread'), true)
  await domain.deleteThread({ threadId: 'healthy-thread' })
  assert.equal(storage.getThread('healthy-thread'), undefined)
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

test('an unrelated failure while resolving a workspace path is not turned into "no owner"', async () => {
  // The owner lookup downgrades one known case — an id that cannot name a
  // workspace — to "not a temporary one". Wrapping it in a catch instead would
  // read the same from outside while also hiding real failures, so this pins
  // which of the two it is.
  const { domain } = createDomainWithRealPathResolution(
    { id: 'thread-1', workspacePath: '/tmp/yachiyo-temp/thread-1' },
    () => {
      throw new Error('workspace root unavailable')
    }
  )

  await assert.rejects(
    () => domain.deleteThread({ threadId: 'thread-1' }),
    /workspace root unavailable/
  )
})
