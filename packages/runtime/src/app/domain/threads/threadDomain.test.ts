import assert from 'node:assert/strict'
import test from 'node:test'

import { withThreadCapabilities } from '@yachiyo/shared/protocol'
import { createInMemoryYachiyoStorage } from '../../../storage/memoryStorage.ts'
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
  events: Array<{
    type: string
    threadId?: string
    thread?: { colorTag?: string; enabledTools?: string[]; runMode?: string }
  }>
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
    resolveThreadWorkspacePath: () => '/tmp/thread-1',
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
    loadThreadToolCalls: (threadId) => storage.listThreadToolCalls(threadId),
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
  assert.equal(coloredThread.updatedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(storage.getThread('thread-1')?.colorTag, 'azure')
  assert.equal(storage.getThread('thread-1')?.updatedAt, '2026-01-01T00:00:00.000Z')
  assert.deepEqual(events.at(-1), {
    type: 'thread.updated',
    threadId: 'thread-1',
    thread: coloredThread
  })

  const defaultThread = domain.setThreadColor({ threadId: 'thread-1', colorTag: null })

  assert.equal(defaultThread.colorTag, undefined)
  assert.equal(defaultThread.updatedAt, '2026-01-01T00:00:00.000Z')
  assert.equal(storage.getThread('thread-1')?.colorTag, undefined)
  assert.equal(storage.getThread('thread-1')?.updatedAt, '2026-01-01T00:00:00.000Z')
  assert.deepEqual(events.at(-1), {
    type: 'thread.updated',
    threadId: 'thread-1',
    thread: defaultThread
  })
})

test('YachiyoServerThreadDomain stores standard tool mode as runMode only', () => {
  const { domain, events, storage } = createThreadDomainHarness(null)

  const updatedThread = domain.setThreadToolMode({
    threadId: 'thread-1',
    enabledTools: []
  })

  assert.equal(updatedThread.enabledTools, undefined)
  assert.equal(updatedThread.runMode, 'chat')
  assert.equal(storage.getThread('thread-1')?.enabledTools, undefined)
  assert.equal(storage.getThread('thread-1')?.runMode, 'chat')
  assert.deepEqual(events.at(-1), {
    type: 'thread.updated',
    threadId: 'thread-1',
    thread: updatedThread
  })
})

test('YachiyoServerThreadDomain sets and clears thread reasoning effort', () => {
  const { domain, events, storage } = createThreadDomainHarness(null)

  const reasoningThread = domain.setThreadReasoningEffort({
    threadId: 'thread-1',
    reasoningEffort: 'high'
  })

  assert.equal(reasoningThread.reasoningEffort, 'high')
  assert.equal(storage.getThread('thread-1')?.reasoningEffort, 'high')
  assert.deepEqual(events.at(-1), {
    type: 'thread.updated',
    threadId: 'thread-1',
    thread: reasoningThread
  })

  const defaultThread = domain.setThreadReasoningEffort({
    threadId: 'thread-1',
    reasoningEffort: null
  })

  assert.equal(defaultThread.reasoningEffort, undefined)
  assert.equal(storage.getThread('thread-1')?.reasoningEffort, undefined)
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

test('YachiyoServerThreadDomain requires confirmation before changing a thread with history', async () => {
  const { domain, storage } = createThreadDomainHarness(null)
  const thread = storage.getThread('thread-1')!
  storage.saveThreadMessage({
    thread,
    updatedThread: { ...thread, headMessageId: 'user-1' },
    message: {
      id: 'user-1',
      threadId: 'thread-1',
      role: 'user',
      content: 'hello',
      status: 'completed',
      createdAt: '2026-01-01T00:00:02.000Z'
    }
  })

  const decision = domain.getWorkspaceChangeDecision({
    threadId: 'thread-1',
    workspacePath: '/tmp/real-workspace'
  })

  assert.equal(decision.allowed, true)
  assert.equal(decision.requiresConfirmation, true)
  await assert.rejects(
    () => domain.updateWorkspace({ threadId: 'thread-1', workspacePath: '/tmp/real-workspace' }),
    /already has conversation history/
  )

  const updated = await domain.updateWorkspace({
    threadId: 'thread-1',
    workspacePath: '/tmp/real-workspace',
    confirmed: true
  })

  assert.equal(updated.workspacePath, '/tmp/real-workspace')
})

test('YachiyoServerThreadDomain blocks ACP workspace changes', () => {
  const { domain } = createThreadDomainHarness({
    kind: 'acp',
    profileId: 'agent-1',
    sessionStatus: 'active',
    sessionId: 'session-1'
  })

  const decision = domain.getWorkspaceChangeDecision({
    threadId: 'thread-1',
    workspacePath: '/tmp/real-workspace'
  })

  assert.equal(decision.allowed, false)
  assert.equal(decision.blockedReason, 'acp-thread')
})

test('YachiyoServerThreadDomain blocks workspace changes while a plan is pending', () => {
  const { domain, storage } = createThreadDomainHarness(null)
  const thread = storage.getThread('thread-1')!
  storage.saveThreadMessage({
    thread,
    updatedThread: { ...thread, headMessageId: 'assistant-plan' },
    message: {
      id: 'assistant-plan',
      threadId: 'thread-1',
      role: 'assistant',
      content: '<!-- yachiyo:plan-document -->\n# Plan',
      status: 'completed',
      createdAt: '2026-01-01T00:00:02.000Z'
    }
  })
  storage.createToolCall({
    id: 'tool-1',
    threadId: 'thread-1',
    toolName: 'exitPlanMode',
    status: 'completed',
    inputSummary: '',
    startedAt: '2026-01-01T00:00:03.000Z'
  })

  const decision = domain.getWorkspaceChangeDecision({
    threadId: 'thread-1',
    workspacePath: '/tmp/real-workspace'
  })

  assert.equal(decision.allowed, false)
  assert.equal(decision.blockedReason, 'pending-plan')
})

test('YachiyoServerThreadDomain clears workspacePath to return to the stable temp workspace', async () => {
  const { domain } = createThreadDomainHarness(null)
  await domain.updateWorkspace({
    threadId: 'thread-1',
    workspacePath: '/tmp/real-workspace',
    confirmed: true
  })

  const decision = domain.getWorkspaceChangeDecision({ threadId: 'thread-1', workspacePath: null })
  assert.equal(decision.targetWorkspacePath, '/tmp/thread-1')

  const updated = await domain.updateWorkspace({ threadId: 'thread-1', workspacePath: null })
  assert.equal(updated.workspacePath, undefined)
})
