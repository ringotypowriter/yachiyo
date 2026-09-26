import assert from 'node:assert/strict'
import test from 'node:test'

import type { MessageRecord, ThreadRecord, ToolCallRecord } from '@yachiyo/shared/protocol'
import type { RemoteThreadDetail } from '@yachiyo/shared/remote/projections'
import { REMOTE_MAX_MESSAGE_BYTES } from '@yachiyo/shared/remote/methods'
import {
  PLAN_DOCUMENT_MARKER,
  PLAN_EXECUTION_USER_MESSAGE,
  hasPendingPlanDocument
} from '@yachiyo/shared/planMode'
import { createInMemoryYachiyoStorage } from '../../../storage/memoryStorage.ts'
import { createRemoteHostOps } from './remoteHostOps.ts'

function fixture(count = 3000): {
  storage: ReturnType<typeof createInMemoryYachiyoStorage>
  thread: ThreadRecord
  messages: MessageRecord[]
  queued: MessageRecord[]
  ops: ReturnType<typeof createRemoteHostOps>
  load: (input?: { limit?: number; beforeMessageId?: string }) => RemoteThreadDetail
} {
  const storage = createInMemoryYachiyoStorage()
  const thread: ThreadRecord = {
    id: 'thread',
    title: 'Long',
    updatedAt: '2026-01-01',
    headMessageId: `m${count - 1}`
  }
  const messages: MessageRecord[] = Array.from({ length: count }, (_, index) => ({
    id: `m${index}`,
    threadId: thread.id,
    parentMessageId: index ? `m${index - 1}` : undefined,
    role: index % 2 ? 'assistant' : 'user',
    content: `body-${index}`,
    status: 'completed',
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    responseMessages: [{ text: 'provider payload' }]
  }))
  storage.createThread({ thread, messages, createdAt: thread.updatedAt })
  const queued: MessageRecord[] = [{ ...messages[0]!, id: 'queued', content: 'queued draft' }]
  const unused = (): never => {
    throw new Error('Unexpected server call')
  }
  const ops = createRemoteHostOps({
    getStorage: () => storage,
    getQueuedFollowUpMessages: () => queued,
    getConfig: unused,
    getSyncStatus: unused,
    listSubagents: unused,
    listBackgroundTasks: unused,
    searchThreadsAndMessages: unused
  })
  const load = (input: { limit?: number; beforeMessageId?: string } = {}): RemoteThreadDetail =>
    ops['host.remote.loadThread']({ threadId: thread.id, ...input })
  return { storage, thread, messages, queued, ops, load }
}

function tool(
  threadId: string,
  id: string,
  requestMessageId: string,
  extra: Partial<ToolCallRecord> = {}
): ToolCallRecord {
  return {
    id,
    threadId,
    requestMessageId,
    toolName: 'bash',
    status: 'completed',
    inputSummary: 'input',
    startedAt: '2026-01-01',
    ...extra
  }
}

test('3000-message normal history reads only 50 page bodies and scoped tools, never all runs', () => {
  const { storage, thread, load } = fixture()
  for (let index = 0; index < 3000; index++) {
    storage.createToolCall(tool(thread.id, `t${index}`, `m${index}`))
    storage.startRun({
      runId: `r${index}`,
      thread,
      updatedThread: thread,
      requestMessageId: `m${index}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    })
  }
  const read = storage.listThreadMessages.bind(storage)
  const readTools = storage.listThreadToolCalls.bind(storage)
  const readRuns = storage.listThreadRuns.bind(storage)
  let bodyCount = 0
  let toolCount = 0
  storage.listThreadMessages = (id, options) => {
    assert.ok(options?.messageIds, 'normal history must never read all bodies')
    assert.equal(options.includeResponseMessages, false)
    const rows = read(id, options)
    bodyCount += rows.length
    assert.ok(rows.every((row) => row.responseMessages === undefined))
    return rows
  }
  storage.listThreadToolCalls = (id, scope) => {
    assert.ok(scope, 'normal history must never deserialize all tool payloads')
    const rows = readTools(id, scope)
    toolCount += rows.length
    return rows
  }
  storage.listThreadRuns = (id, options) => {
    assert.deepEqual(options, { limit: 1 })
    return readRuns(id, options)
  }
  const page = load()
  assert.equal(page.activeRunId, 'r2999')
  assert.equal(page.messages.length, 50)
  assert.equal(bodyCount, 50)
  assert.equal(toolCount, 50)
  assert.equal(page.hasMoreBefore, true)
  assert.equal(page.messages[0]?.id, 'm2950')
  assert.equal(page.queuedFollowUps[0]?.content, 'queued draft')
  const previous = load({ beforeMessageId: 'm2950' })
  assert.equal(previous.messages[0]?.id, 'm2900')
  assert.equal(bodyCount, 100)
})

test('thread summaries paginate local threads without consuming cursor slots for sync mirrors', () => {
  const { storage, thread } = fixture(1)
  storage.createThread({
    thread: {
      id: 'mirror-new',
      title: 'Mirror',
      updatedAt: '2026-01-05',
      syncOriginDeviceId: 'other-device'
    },
    createdAt: '2026-01-05'
  })
  storage.createThread({
    thread: { id: 'local-new', title: 'Local', updatedAt: '2026-01-04' },
    createdAt: '2026-01-04'
  })
  storage.createThread({
    thread: {
      id: 'mirror-middle',
      title: 'Mirror',
      updatedAt: '2026-01-03',
      syncOriginDeviceId: 'other-device'
    },
    createdAt: '2026-01-03'
  })
  const unused = (): never => {
    throw new Error('Unexpected server call')
  }
  const ops = createRemoteHostOps({
    getStorage: () => storage,
    getQueuedFollowUpMessages: unused,
    getConfig: unused,
    getSyncStatus: unused,
    listSubagents: unused,
    listBackgroundTasks: unused,
    searchThreadsAndMessages: unused
  })

  const first = ops['host.remote.listThreadSummaries']({ limit: 1 })
  assert.deepEqual(
    first.threads.map((item) => item.id),
    ['local-new']
  )
  assert.ok(first.nextCursor)
  const second = ops['host.remote.listThreadSummaries']({ cursor: first.nextCursor, limit: 1 })
  assert.deepEqual(
    second.threads.map((item) => item.id),
    [thread.id]
  )
  assert.equal(second.nextCursor, undefined)
  assert.equal(ops['host.remote.getThreadSummary']({ threadId: 'mirror-new' }), null)
  assert.ok(ops['host.remote.getThreadSummary']({ threadId: thread.id }))
  assert.throws(() => ops['host.remote.loadThread']({ threadId: 'mirror-new' }), {
    name: 'RemoteNotFound'
  })
})

test('remote inbox omits only empty idle New Chat threads before pagination and push summaries', () => {
  const { storage, ops } = fixture(1)
  const create = (id: string, extra: Partial<ThreadRecord> = {}): ThreadRecord => {
    const thread: ThreadRecord = { id, title: 'New Chat', updatedAt: '2026-01-02', ...extra }
    storage.createThread({ thread, createdAt: thread.updatedAt })
    return thread
  }
  create('blank')
  create('preview', { preview: 'Hello' })
  create('message', { headMessageId: 'image-only' })
  const running = create('running')
  storage.startRun({
    runId: 'run',
    thread: running,
    updatedThread: running,
    requestMessageId: 'request',
    createdAt: running.updatedAt
  })

  assert.equal(ops['host.remote.getThreadSummary']({ threadId: 'blank' }), null)
  assert.ok(ops['host.remote.getThreadSummary']({ threadId: 'message' }))
  assert.ok(ops['host.remote.getThreadSummary']({ threadId: 'running' }))
  const first = ops['host.remote.listThreadSummaries']({ limit: 2 })
  const second = ops['host.remote.listThreadSummaries']({ cursor: first.nextCursor, limit: 2 })
  assert.deepEqual(
    [...first.threads, ...second.threads].map((item) => item.id),
    ['preview', 'message', 'running', 'thread']
  )
  assert.equal(second.nextCursor, undefined)
})

test('ancestry order, hidden ancestors, sibling metadata and cursor rejection survive body paging', () => {
  const { storage, thread, messages, load } = fixture(5)
  storage.updateMessage({ ...messages[2]!, hidden: true })
  storage.updateMessage({ ...messages[3]!, createdAt: '2020-01-01' })
  storage.saveThreadMessage({
    thread,
    updatedThread: thread,
    message: { ...messages[4]!, id: 'sibling', hidden: true, createdAt: '2027-01-01' }
  })
  const page = load({ limit: 2 })
  assert.deepEqual(
    page.messages.map((m) => m.id),
    ['m3', 'm4']
  )
  assert.deepEqual(page.messages[1]?.siblingIds, ['m4', 'sibling'])
  const previous = load({ limit: 2, beforeMessageId: 'm3' })
  assert.deepEqual(
    previous.messages.map((m) => m.id),
    ['m0', 'm1']
  )
  assert.equal(previous.hasMoreBefore, false)
  for (const beforeMessageId of ['m2', 'sibling', 'missing']) {
    assert.throws(() => load({ beforeMessageId }), { name: 'RemoteNotFound' })
  }
  assert.deepEqual(load({ limit: 0 }).messages, [])
})

test('active-run tools remain included, while off-page waiting attention remains thread-wide', () => {
  const { storage, thread, load } = fixture(100)
  storage.startRun({
    runId: 'active',
    thread,
    updatedThread: thread,
    requestMessageId: 'm99',
    createdAt: '2027-01-01'
  })
  storage.createToolCall(tool(thread.id, 'active-old', 'm0', { runId: 'active' }))
  storage.createToolCall(tool(thread.id, 'waiting-elsewhere', 'm1', { status: 'waiting-for-user' }))
  storage.createToolCall(tool(thread.id, 'old', 'm2'))
  const page = load({ limit: 1 })
  assert.equal(page.activeRunId, 'active')
  assert.equal(page.thread.needsAttention, true)
  assert.deepEqual(
    page.toolCalls.map((t) => t.id),
    ['active-old']
  )
})

test('legacy plan mode uses canonical nonlocal plan acceptance semantics outside the page', () => {
  const { storage, thread, messages, load } = fixture(100)
  storage.updateMessage({ ...messages[0]!, turnContext: { runMode: 'plan' } })
  storage.startRun({
    runId: 'plan',
    thread,
    updatedThread: thread,
    requestMessageId: 'm0',
    createdAt: '2026-01-01'
  })
  storage.completeRun({ runId: 'plan', updatedThread: thread, assistantMessage: messages[99]! })
  storage.createToolCall(
    tool(thread.id, 'exit', 'm0', {
      toolName: 'exitPlanMode',
      startedAt: '2026-01-01',
      finishedAt: '2026-01-01'
    })
  )
  assert.equal(load({ limit: 1 }).pendingPlan, true)
  storage.saveThreadMessage({
    thread,
    updatedThread: thread,
    message: {
      ...messages[1]!,
      id: 'plan-doc',
      content: PLAN_DOCUMENT_MARKER + '\nplan',
      createdAt: '2026-01-02'
    }
  })
  storage.saveThreadMessage({
    thread,
    updatedThread: thread,
    message: {
      ...messages[0]!,
      id: 'acceptance',
      parentMessageId: 'plan-doc',
      content: PLAN_EXECUTION_USER_MESSAGE,
      createdAt: '2026-01-03'
    }
  })
  const expected = hasPendingPlanDocument({
    messages: storage.listThreadMessages(thread.id, { includeResponseMessages: false }),
    toolCalls: storage.listThreadToolCalls(thread.id)
  })
  assert.equal(expected, false)
  assert.equal(load({ limit: 1 }).pendingPlan, expected)
})

test('UTF-8 byte budget shrinks oldest page rows without rereads or truncating active state', () => {
  const { storage, thread, messages, load } = fixture(4)
  const content = '界'.repeat(1024 * 1024)
  for (const message of messages) {
    storage.updateMessage({ ...message, content })
    storage.createToolCall(tool(thread.id, `tool-${message.id}`, message.id))
  }
  storage.startRun({
    runId: 'active',
    thread,
    updatedThread: thread,
    requestMessageId: 'm3',
    createdAt: '2027-01-01'
  })
  storage.createToolCall(
    tool(thread.id, 'active-old', 'm0', {
      runId: 'active',
      status: 'waiting-for-user'
    })
  )
  const read = storage.listThreadMessages.bind(storage)
  let reads = 0
  storage.listThreadMessages = (id, options) => {
    assert.ok(options?.messageIds)
    assert.equal(options.includeResponseMessages, false)
    reads++
    return read(id, options)
  }
  const page = load()
  assert.equal(reads, 1, 'adaptive projection must not refetch rows')
  assert.deepEqual(
    page.messages.map((message) => message.id),
    ['m2', 'm3']
  )
  assert.ok(page.messages.every((message) => message.content === content))
  assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') < REMOTE_MAX_MESSAGE_BYTES - 64 * 1024)
  assert.equal(page.hasMoreBefore, true)
  assert.equal(page.thread.needsAttention, true)
  assert.equal(page.activeRunId, 'active')
  assert.equal(page.pendingPlan, false)
  assert.equal(page.queuedFollowUps[0]?.content, 'queued draft')
  assert.deepEqual(
    new Set(page.toolCalls.map((call) => call.id)),
    new Set(['tool-m2', 'tool-m3', 'active-old'])
  )
  const previous = load({ beforeMessageId: page.messages[0]!.id })
  assert.equal(reads, 2)
  assert.deepEqual(
    previous.messages.map((message) => message.id),
    ['m0', 'm1']
  )
  assert.equal(previous.hasMoreBefore, false)
})

test('a single oversized message or nonpaged queue returns a validation error instead of truncation', () => {
  const { storage, messages, queued, load } = fixture(1)
  const oversized = '界'.repeat(3 * 1024 * 1024)
  storage.updateMessage({ ...messages[0]!, content: oversized })
  assert.throws(() => load(), {
    name: 'RemoteValidationError',
    message: /too large to load remotely/
  })
  storage.updateMessage(messages[0]!)
  queued[0] = { ...queued[0]!, content: oversized }
  assert.throws(() => load(), {
    name: 'RemoteValidationError',
    message: /too large to load remotely/
  })
  assert.equal(queued[0].content, oversized)
})

function opsFor(
  storage: ReturnType<typeof createInMemoryYachiyoStorage>
): ReturnType<typeof createRemoteHostOps> {
  const unused = (): never => {
    throw new Error('Unexpected server call')
  }
  return createRemoteHostOps({
    getStorage: () => storage,
    getQueuedFollowUpMessages: () => [],
    getConfig: unused,
    getSyncStatus: unused,
    listSubagents: unused,
    listBackgroundTasks: unused,
    searchThreadsAndMessages: unused
  })
}

test('guest and group channel threads are never exposed; owner DMs are', () => {
  const storage = createInMemoryYachiyoStorage()
  const channelUser = (id: string, role: 'owner' | 'guest'): void => {
    storage.createChannelUser({
      id,
      platform: 'telegram',
      externalUserId: id,
      username: id,
      label: id,
      status: 'allowed',
      role,
      usageLimitKTokens: null,
      workspacePath: '/tmp'
    })
  }
  channelUser('owner-user', 'owner')
  channelUser('guest-user', 'guest')
  const create = (id: string, extra: Partial<ThreadRecord>): void => {
    storage.createThread({
      thread: { id, title: id, preview: 'hi', updatedAt: '2026-01-01', ...extra },
      createdAt: '2026-01-01'
    })
  }
  create('local', {})
  create('owner-dm', { source: 'telegram', channelUserId: 'owner-user' })
  create('guest-dm', { source: 'telegram', channelUserId: 'guest-user' })
  create('group', { source: 'telegram', channelUserId: 'owner-user', channelGroupId: 'g' })
  storage.createToolCall(tool('guest-dm', 'guest-tool', 'm', { outputSummary: 'secret' }))
  const ops = opsFor(storage)

  assert.deepEqual(
    ops['host.remote.listThreadSummaries']({})
      .threads.map((thread) => thread.id)
      .sort(),
    ['local', 'owner-dm']
  )
  for (const hidden of ['guest-dm', 'group']) {
    assert.equal(ops['host.remote.getThreadSummary']({ threadId: hidden }), null)
    assert.equal(ops['host.remote.getThreadVisibility']({ threadId: hidden }), false)
    assert.throws(() => ops['host.remote.loadThread']({ threadId: hidden }), {
      name: 'RemoteNotFound'
    })
  }
  assert.throws(
    () => ops['host.remote.getToolPreview']({ threadId: 'guest-dm', toolCallId: 'guest-tool' }),
    { name: 'RemoteNotFound' }
  )
  assert.throws(
    () => ops['host.remote.getImage']({ threadId: 'guest-dm', messageId: 'm', imageId: '0' }),
    { name: 'RemoteNotFound' }
  )
  assert.ok(ops['host.remote.getThreadSummary']({ threadId: 'owner-dm' }))
  assert.equal(ops['host.remote.getThreadVisibility']({ threadId: 'owner-dm' }), true)
  assert.equal(ops['host.remote.getThreadVisibility']({ threadId: 'missing' }), null)
})

test('inbox paging snapshots the order once, so later pages skip nothing and repeat nothing', () => {
  const storage = createInMemoryYachiyoStorage()
  for (let index = 0; index < 5; index++) {
    storage.createThread({
      thread: {
        id: `t${index}`,
        title: `Thread ${index}`,
        updatedAt: `2026-01-0${5 - index}`
      },
      createdAt: '2026-01-01'
    })
  }
  const bootstrap = storage.bootstrap.bind(storage)
  let bootstraps = 0
  storage.bootstrap = () => {
    bootstraps += 1
    return bootstrap()
  }
  const ops = opsFor(storage)
  const first = ops['host.remote.listThreadSummaries']({ limit: 2 })
  assert.deepEqual(
    first.threads.map((thread) => thread.id),
    ['t0', 't1']
  )
  // The last thread moves to the top and another is archived while the phone pages.
  const moved = storage.getThread('t4')!
  storage.updateThread({ ...moved, title: 'Renamed', updatedAt: '2026-02-01' })
  storage.archiveThread({ threadId: 't2', archivedAt: '2026-02-01', updatedAt: '2026-02-01' })
  const second = ops['host.remote.listThreadSummaries']({ cursor: first.nextCursor, limit: 2 })
  const third = ops['host.remote.listThreadSummaries']({ cursor: second.nextCursor, limit: 2 })
  assert.deepEqual(
    [...second.threads, ...third.threads].map((thread) => [thread.id, thread.title]),
    [
      ['t3', 'Thread 3'],
      ['t4', 'Renamed']
    ]
  )
  assert.equal(third.nextCursor, undefined)
  assert.equal(bootstraps, 1, 'later pages read only their own threads')

  // A legacy offset cursor still pages from a fresh snapshot.
  const legacy = ops['host.remote.listThreadSummaries']({ cursor: '3', limit: 10 })
  assert.deepEqual(
    legacy.threads.map((thread) => thread.id),
    ['t3'],
    'fresh order: t4, t0, t1, t3'
  )
  assert.throws(() => ops['host.remote.listThreadSummaries']({ cursor: 'bogus' }), /cursor/)
})

test('omitToolPreviews marks previews for on-demand fetch by tool call id', () => {
  const { storage, thread, ops } = fixture(4)
  storage.createToolCall(tool(thread.id, 'with-output', 'm3', { outputSummary: 'x'.repeat(50) }))
  storage.createToolCall(tool(thread.id, 'bare', 'm3'))
  const load = (omitToolPreviews: boolean): RemoteThreadDetail =>
    ops['host.remote.loadThread']({ threadId: thread.id, omitToolPreviews })

  const full = load(false).toolCalls.find((call) => call.id === 'with-output')!
  assert.equal(full.outputPreview, 'x'.repeat(50))
  const light = load(true).toolCalls
  const omitted = light.find((call) => call.id === 'with-output')!
  assert.equal(omitted.outputPreview, undefined)
  assert.equal(omitted.hasPreview, true)
  assert.equal(light.find((call) => call.id === 'bare')!.hasPreview, undefined)

  const readTools = storage.listThreadToolCalls.bind(storage)
  storage.listThreadToolCalls = (id, scope) => {
    assert.deepEqual(scope, { messageIds: [], toolCallIds: ['with-output'] })
    return readTools(id, scope)
  }
  assert.deepEqual(
    ops['host.remote.getToolPreview']({ threadId: thread.id, toolCallId: 'with-output' }),
    { outputPreview: 'x'.repeat(50), truncated: false }
  )
  storage.listThreadToolCalls = readTools
  assert.throws(
    () => ops['host.remote.getToolPreview']({ threadId: thread.id, toolCallId: 'missing' }),
    { name: 'RemoteNotFound' }
  )
})
