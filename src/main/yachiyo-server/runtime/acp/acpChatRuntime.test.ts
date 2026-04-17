import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import type { ContentBlock } from '@agentclientprotocol/sdk'

import { createInMemoryYachiyoStorage } from '../../storage/memoryStorage.ts'
import { runAcpChatThread, buildAcpPromptBlocks } from './acpChatRuntime.ts'
import type { AcpChatRunDeps, AcpChatRunInput } from './acpChatRuntime.ts'
import type { AcpLaunchResult } from './acpLauncher.ts'
import type {
  MessageImageRecord,
  MessageRecord,
  SettingsConfig,
  SubagentProfile,
  ThreadRecord
} from '../../../../shared/yachiyo/protocol.ts'
import type { YachiyoServerEvent } from '../../../../shared/yachiyo/protocol.ts'

function makeThread(
  workspacePath: string,
  runtimeBinding: ThreadRecord['runtimeBinding'] = {
    kind: 'acp',
    profileId: 'agent-1',
    profileName: 'Test Agent',
    sessionStatus: 'new'
  }
): ThreadRecord {
  return {
    id: 'thread-1',
    title: 'Test thread',
    updatedAt: '2026-01-01T00:00:00.000Z',
    runtimeBinding,
    workspacePath
  }
}

function makeProfile(): SubagentProfile {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    enabled: true,
    description: '',
    command: 'false',
    args: [] as string[],
    env: {} as Record<string, string>
  }
}

function makeConfig(): SettingsConfig {
  return {
    apiKey: '',
    providerName: '',
    model: '',
    enabledTools: [],
    providers: [],
    subagentProfiles: [makeProfile()]
  } as unknown as SettingsConfig
}

function makeDeps(
  workspacePath: string,
  options: {
    runtimeBinding?: ThreadRecord['runtimeBinding']
  } = {}
): AcpChatRunDeps & {
  emittedEvents: YachiyoServerEvent[]
  storage: ReturnType<typeof createInMemoryYachiyoStorage>
} {
  const storage = createInMemoryYachiyoStorage()
  const thread = makeThread(workspacePath, options.runtimeBinding)
  const requestMessage: MessageRecord = {
    id: 'msg-req',
    threadId: thread.id,
    role: 'user',
    content: 'hello',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z'
  }

  storage.createThread({
    thread,
    createdAt: '2026-01-01T00:00:00.000Z',
    messages: [requestMessage]
  })
  storage.startRun({
    runId: 'run-1',
    requestMessageId: 'msg-req',
    thread,
    updatedThread: thread,
    createdAt: '2026-01-01T00:00:01.000Z'
  })

  const emittedEvents: YachiyoServerEvent[] = []

  return {
    storage,
    createId: (() => {
      let n = 0
      return () => `id-${++n}`
    })(),
    timestamp: () => '2026-01-01T00:01:00.000Z',
    emit: <T extends YachiyoServerEvent>(event: T) => {
      emittedEvents.push(event)
    },
    readThread: (threadId: string) => {
      const t = storage.getThread(threadId)
      if (!t) throw new Error(`Thread ${threadId} not found`)
      return t
    },
    readConfig: () => makeConfig(),
    loadThreadMessages: (threadId: string) => storage.listThreadMessages(threadId),
    ensureThreadWorkspace: async () => workspacePath,
    // Inject a no-op pool to prevent tests from interacting with the module singleton.
    acpProcessPool: { checkout: () => null, checkin: () => {} },
    emittedEvents
  } as AcpChatRunDeps & {
    emittedEvents: YachiyoServerEvent[]
    storage: ReturnType<typeof createInMemoryYachiyoStorage>
  }
}

function makeFakeLaunchResult(): AcpLaunchResult {
  return {
    proc: {
      stderr: new EventEmitter(),
      kill: () => undefined
    } as never,
    stream: {} as never,
    procExited: Promise.resolve()
  }
}

test('runAcpChatThread cancel: calls storage.cancelRun when aborted before ACP session starts', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'acp-test-'))

  const deps = makeDeps(workspacePath)

  let cancelRunCalled = false
  let completeRunCalled = false
  const originalCancelRun = deps.storage.cancelRun.bind(deps.storage)
  deps.storage.cancelRun = (input) => {
    cancelRunCalled = true
    assert.equal(input.runId, 'run-1')
    originalCancelRun(input)
  }
  deps.storage.completeRun = () => {
    completeRunCalled = true
    throw new Error('completeRun must not be called on cancel')
  }

  const abortController = new AbortController()
  abortController.abort()

  const input: AcpChatRunInput = {
    runId: 'run-1',
    thread: makeThread(workspacePath),
    requestMessageId: 'msg-req',
    abortController,
    updateHeadOnComplete: true
  }

  const result = await runAcpChatThread(deps, input)

  assert.equal(result.kind, 'cancelled')
  assert.equal(cancelRunCalled, true, 'cancelRun must be called on cancel')
  assert.equal(completeRunCalled, false, 'completeRun must NOT be called on cancel')
})

test('runAcpChatThread marks resumed ACP sessions expired after resume failure', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'acp-test-'))
  const deps = makeDeps(workspacePath, {
    runtimeBinding: {
      kind: 'acp',
      profileId: 'agent-1',
      profileName: 'Test Agent',
      sessionId: 'session-old',
      sessionStatus: 'active',
      lastSessionBoundAt: '2026-01-01T00:00:30.000Z'
    }
  })

  deps.launchAcpProcess = () => makeFakeLaunchResult()
  deps.runAcpSession = async () => {
    throw new Error('Session resume failed for session_id "session-old": missing session')
  }

  const result = await runAcpChatThread(deps, {
    runId: 'run-1',
    thread: makeThread(workspacePath, {
      kind: 'acp',
      profileId: 'agent-1',
      profileName: 'Test Agent',
      sessionId: 'session-old',
      sessionStatus: 'active',
      lastSessionBoundAt: '2026-01-01T00:00:30.000Z'
    }),
    requestMessageId: 'msg-req',
    abortController: new AbortController(),
    updateHeadOnComplete: true
  })

  assert.equal(result.kind, 'failed')

  const storedThread = deps.storage.getThread('thread-1')
  assert.equal(storedThread?.runtimeBinding?.sessionStatus, 'expired')
  assert.equal(storedThread?.runtimeBinding?.sessionId, undefined)
  assert.equal(storedThread?.runtimeBinding?.lastSessionBoundAt, '2026-01-01T00:00:30.000Z')

  const messages = deps.storage.listThreadMessages('thread-1')
  const failedMessage = messages.at(-1)
  assert.equal(failedMessage?.status, 'failed')
  assert.equal(
    deps.emittedEvents.some(
      (event) =>
        event.type === 'thread.updated' && event.thread.runtimeBinding?.sessionStatus === 'expired'
    ),
    true
  )
})

test('runAcpChatThread persists a stopped assistant message when cancellation happens after output starts', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'acp-test-'))
  const deps = makeDeps(workspacePath)
  const abortController = new AbortController()

  deps.launchAcpProcess = () => makeFakeLaunchResult()
  deps.runAcpSession = async (_stream, _proc, _procExited, _cwd, _prompt, adapter) => {
    await adapter.yoloClient.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'read',
        status: 'running'
      }
    } as never)
    await adapter.yoloClient.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'read',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'partial' } }]
      }
    } as never)
    adapter.onStderr(Buffer.from('partial reply'))
    abortController.abort()
    throw new Error('Aborted mid-stream')
  }

  const result = await runAcpChatThread(deps, {
    runId: 'run-1',
    thread: makeThread(workspacePath),
    requestMessageId: 'msg-req',
    abortController,
    updateHeadOnComplete: true
  })

  assert.equal(result.kind, 'cancelled')

  const messages = deps.storage.listThreadMessages('thread-1')
  const stoppedMessage = messages.at(-1)
  assert.equal(stoppedMessage?.status, 'stopped')
  assert.equal(stoppedMessage?.content, 'partial reply')
  assert.equal(stoppedMessage?.providerName, 'acp')
  const storedToolCall = deps.storage.listThreadToolCalls('thread-1')[0]
  assert.equal(storedToolCall?.assistantMessageId, stoppedMessage?.id)

  const storedThread = deps.storage.getThread('thread-1')
  assert.equal(storedThread?.headMessageId, stoppedMessage?.id)
  assert.equal(storedThread?.preview, 'partial reply')
  assert.equal(
    deps.emittedEvents.some(
      (event) => event.type === 'message.completed' && event.message.status === 'stopped'
    ),
    true
  )
})

test('runAcpChatThread cancel preserves the existing head when head updates are disabled', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'acp-test-'))
  const deps = makeDeps(workspacePath)
  const abortController = new AbortController()
  const thread = {
    ...makeThread(workspacePath),
    headMessageId: 'msg-req'
  } satisfies ThreadRecord

  deps.storage.updateThread(thread)
  deps.launchAcpProcess = () => makeFakeLaunchResult()
  deps.runAcpSession = async (_stream, _proc, _procExited, _cwd, _prompt, adapter) => {
    adapter.onStderr(Buffer.from('partial reply'))
    abortController.abort()
    throw new Error('Aborted mid-stream')
  }

  const result = await runAcpChatThread(deps, {
    runId: 'run-1',
    thread,
    requestMessageId: 'msg-req',
    abortController,
    updateHeadOnComplete: false
  })

  assert.equal(result.kind, 'cancelled')

  const messages = deps.storage.listThreadMessages('thread-1')
  const stoppedMessage = messages.at(-1)
  assert.equal(stoppedMessage?.status, 'stopped')
  assert.equal(stoppedMessage?.content, 'partial reply')

  const storedThread = deps.storage.getThread('thread-1')
  assert.equal(storedThread?.headMessageId, 'msg-req')
  assert.equal(storedThread?.preview, 'partial reply')
})

test('runAcpChatThread persists ACP tool-call bindings on successful completion', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'acp-test-'))
  const deps = makeDeps(workspacePath)

  deps.launchAcpProcess = () => makeFakeLaunchResult()
  deps.runAcpSession = async (_stream, _proc, _procExited, _cwd, _prompt, adapter) => {
    await adapter.yoloClient.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'read',
        status: 'running'
      }
    } as never)
    await adapter.yoloClient.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'read',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'done' } }]
      }
    } as never)

    return {
      sessionId: 'session-1',
      lastMessageText: 'final reply',
      stopReason: 'end_turn'
    }
  }

  const result = await runAcpChatThread(deps, {
    runId: 'run-1',
    thread: makeThread(workspacePath),
    requestMessageId: 'msg-req',
    abortController: new AbortController(),
    updateHeadOnComplete: true
  })

  assert.equal(result.kind, 'completed')

  const completedMessage = deps.storage.listThreadMessages('thread-1').at(-1)
  const storedToolCall = deps.storage.listThreadToolCalls('thread-1')[0]
  assert.equal(storedToolCall?.assistantMessageId, completedMessage?.id)
})

test('runAcpChatThread anchors tool calls to a stopped message even when no text was streamed', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'acp-test-'))
  const deps = makeDeps(workspacePath)
  const abortController = new AbortController()

  deps.launchAcpProcess = () => makeFakeLaunchResult()
  deps.runAcpSession = async (_stream, _proc, _procExited, _cwd, _prompt, adapter) => {
    await adapter.yoloClient.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'bash',
        status: 'running'
      }
    } as never)
    abortController.abort()
    throw new Error('Aborted mid-tool')
  }

  const result = await runAcpChatThread(deps, {
    runId: 'run-1',
    thread: makeThread(workspacePath),
    requestMessageId: 'msg-req',
    abortController,
    updateHeadOnComplete: true
  })

  assert.equal(result.kind, 'cancelled')

  const messages = deps.storage.listThreadMessages('thread-1')
  const stoppedMessage = messages.at(-1)
  assert.equal(stoppedMessage?.status, 'stopped')
  assert.equal(stoppedMessage?.content, '')

  const storedToolCall = deps.storage.listThreadToolCalls('thread-1')[0]
  assert.equal(storedToolCall?.assistantMessageId, stoppedMessage?.id)
  assert.equal(storedToolCall?.status, 'failed')
})

test('runAcpChatThread does not inject synthetic newlines into the persisted buffer', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'acp-test-'))
  const deps = makeDeps(workspacePath)
  const abortController = new AbortController()

  deps.launchAcpProcess = () => makeFakeLaunchResult()
  deps.runAcpSession = async (_stream, _proc, _procExited, _cwd, _prompt, adapter) => {
    await adapter.yoloClient.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' }
      }
    } as never)
    await adapter.yoloClient.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'read',
        status: 'running'
      }
    } as never)
    await adapter.yoloClient.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'read',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'ok' } }]
      }
    } as never)
    await adapter.yoloClient.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' world' }
      }
    } as never)
    abortController.abort()
    throw new Error('Aborted after interleaved text')
  }

  const result = await runAcpChatThread(deps, {
    runId: 'run-1',
    thread: makeThread(workspacePath),
    requestMessageId: 'msg-req',
    abortController,
    updateHeadOnComplete: true
  })

  assert.equal(result.kind, 'cancelled')

  const messages = deps.storage.listThreadMessages('thread-1')
  const stoppedMessage = messages.at(-1)
  assert.equal(stoppedMessage?.content, 'Hello world')
})

// --- buildAcpPromptBlocks unit tests ---

test('buildAcpPromptBlocks: text-only message produces a single text block', () => {
  const blocks = buildAcpPromptBlocks({ content: 'hello world', images: undefined })
  assert.equal(blocks.length, 1)
  assert.deepEqual(blocks[0], { type: 'text', text: 'hello world' })
})

test('buildAcpPromptBlocks: message with images produces text block followed by image blocks', () => {
  const images: MessageImageRecord[] = [
    { dataUrl: 'data:image/png;base64,abc123', mediaType: 'image/png' },
    { dataUrl: 'data:image/jpeg;base64,xyz789', mediaType: 'image/jpeg' }
  ]
  const blocks = buildAcpPromptBlocks({ content: 'look at this', images })
  assert.equal(blocks.length, 3)
  assert.deepEqual(blocks[0], { type: 'text', text: 'look at this' })
  assert.deepEqual(blocks[1], { type: 'image', mimeType: 'image/png', data: 'abc123' })
  assert.deepEqual(blocks[2], { type: 'image', mimeType: 'image/jpeg', data: 'xyz789' })
})

test('buildAcpPromptBlocks: invalid dataUrl entries are skipped', () => {
  const images: MessageImageRecord[] = [
    { dataUrl: 'not-a-data-url', mediaType: 'image/png' },
    { dataUrl: 'data:image/png;base64,valid99', mediaType: 'image/png' }
  ]
  const blocks = buildAcpPromptBlocks({ content: 'hi', images })
  assert.equal(blocks.length, 2)
  assert.deepEqual(blocks[0], { type: 'text', text: 'hi' })
  assert.deepEqual(blocks[1], { type: 'image', mimeType: 'image/png', data: 'valid99' })
})

// --- Integration test: image forwarding via runAcpChatThread ---

function makeDepsWithRequestMessage(
  workspacePath: string,
  requestMessage: MessageRecord
): AcpChatRunDeps & {
  emittedEvents: YachiyoServerEvent[]
  storage: ReturnType<typeof createInMemoryYachiyoStorage>
} {
  const storage = createInMemoryYachiyoStorage()
  const thread = makeThread(workspacePath)

  storage.createThread({
    thread,
    createdAt: '2026-01-01T00:00:00.000Z',
    messages: [requestMessage]
  })
  storage.startRun({
    runId: 'run-1',
    requestMessageId: requestMessage.id,
    thread,
    updatedThread: thread,
    createdAt: '2026-01-01T00:00:01.000Z'
  })

  const emittedEvents: YachiyoServerEvent[] = []

  return {
    storage,
    createId: (() => {
      let n = 0
      return () => `id-${++n}`
    })(),
    timestamp: () => '2026-01-01T00:01:00.000Z',
    emit: <T extends YachiyoServerEvent>(event: T) => {
      emittedEvents.push(event)
    },
    readThread: (threadId: string) => {
      const t = storage.getThread(threadId)
      if (!t) throw new Error(`Thread ${threadId} not found`)
      return t
    },
    readConfig: () => makeConfig(),
    loadThreadMessages: (threadId: string) => storage.listThreadMessages(threadId),
    ensureThreadWorkspace: async () => workspacePath,
    acpProcessPool: { checkout: () => null, checkin: () => {} },
    emittedEvents
  } as AcpChatRunDeps & {
    emittedEvents: YachiyoServerEvent[]
    storage: ReturnType<typeof createInMemoryYachiyoStorage>
  }
}

test('runAcpChatThread forwards images from request message as ACP ContentBlocks', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'acp-test-'))
  const requestMessage: MessageRecord = {
    id: 'msg-req',
    threadId: 'thread-1',
    role: 'user',
    content: 'describe this image',
    images: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mediaType: 'image/png' }],
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z'
  }
  const deps = makeDepsWithRequestMessage(workspacePath, requestMessage)

  let capturedPrompt: ContentBlock[] | null = null
  deps.launchAcpProcess = () => makeFakeLaunchResult()
  deps.runAcpSession = async (_stream, _proc, _procExited, _cwd, prompt) => {
    capturedPrompt = prompt
    return { sessionId: 'session-1', lastMessageText: 'a cat', stopReason: 'end_turn' }
  }

  await runAcpChatThread(deps, {
    runId: 'run-1',
    thread: makeThread(workspacePath),
    requestMessageId: 'msg-req',
    abortController: new AbortController(),
    updateHeadOnComplete: true
  })

  assert.ok(capturedPrompt !== null, 'runAcpSession must be called')
  assert.equal((capturedPrompt as ContentBlock[]).length, 2)
  assert.deepEqual((capturedPrompt as ContentBlock[])[0], {
    type: 'text',
    text: 'describe this image'
  })
  assert.deepEqual((capturedPrompt as ContentBlock[])[1], {
    type: 'image',
    mimeType: 'image/png',
    data: 'iVBORw0KGgo='
  })
})

test('runAcpChatThread sends only text block when message has no images', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'acp-test-'))
  const deps = makeDeps(workspacePath)

  let capturedPrompt: ContentBlock[] | null = null
  deps.launchAcpProcess = () => makeFakeLaunchResult()
  deps.runAcpSession = async (_stream, _proc, _procExited, _cwd, prompt) => {
    capturedPrompt = prompt
    return { sessionId: 'session-1', lastMessageText: 'ok', stopReason: 'end_turn' }
  }

  await runAcpChatThread(deps, {
    runId: 'run-1',
    thread: makeThread(workspacePath),
    requestMessageId: 'msg-req',
    abortController: new AbortController(),
    updateHeadOnComplete: true
  })

  assert.ok(capturedPrompt !== null, 'runAcpSession must be called')
  assert.deepEqual(capturedPrompt as ContentBlock[], [{ type: 'text', text: 'hello' }])
})

test('runAcpChatThread ignores a stale warm ACP session after the profile command changes', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'acp-test-'))
  const deps = makeDeps(workspacePath)
  const staleSession = {
    proc: {
      stderr: new EventEmitter(),
      kill: () => undefined
    } as never,
    connection: {} as never,
    sessionId: 'session-old',
    procExited: Promise.resolve(),
    adapterRef: { current: {} as never }
  }

  let continueCalled = false
  let launchCalled = false

  deps.readConfig = () =>
    ({
      ...makeConfig(),
      subagentProfiles: [
        {
          ...makeProfile(),
          command: 'new-agent'
        }
      ]
    }) as unknown as SettingsConfig
  deps.acpProcessPool = {
    checkout: (key) => (key === ('thread-1' as never) ? staleSession : null),
    checkin: () => {}
  }
  deps.continueAcpSession = async () => {
    continueCalled = true
    return {
      sessionId: 'session-old',
      lastMessageText: 'stale reply',
      stopReason: 'end_turn'
    }
  }
  deps.launchAcpProcess = () => {
    launchCalled = true
    return makeFakeLaunchResult()
  }
  deps.runAcpSession = async () => ({
    sessionId: 'session-new',
    lastMessageText: 'fresh reply',
    stopReason: 'end_turn'
  })

  const result = await runAcpChatThread(deps, {
    runId: 'run-1',
    thread: makeThread(workspacePath),
    requestMessageId: 'msg-req',
    abortController: new AbortController(),
    updateHeadOnComplete: true
  })

  assert.equal(result.kind, 'completed')
  assert.equal(continueCalled, false)
  assert.equal(launchCalled, true)
  assert.equal(deps.storage.listThreadMessages('thread-1').at(-1)?.content, 'fresh reply')
})

test('runAcpChatThread kills a preserved ACP process when persistence fails before check-in', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'acp-test-'))
  const deps = makeDeps(workspacePath)
  const launchResult = makeFakeLaunchResult()
  const signals: NodeJS.Signals[] = []
  let checkinCalled = false

  launchResult.proc.kill = (signal?: NodeJS.Signals | number) => {
    signals.push((signal as NodeJS.Signals) ?? 'SIGTERM')
    return true
  }

  deps.launchAcpProcess = () => launchResult
  deps.runAcpSession = async () => ({
    sessionId: 'session-1',
    lastMessageText: 'final reply',
    stopReason: 'end_turn',
    warmSession: {
      proc: launchResult.proc,
      connection: {} as never,
      sessionId: 'session-1',
      procExited: launchResult.procExited,
      adapterRef: { current: {} as never }
    }
  })
  deps.storage.completeRun = () => {
    throw new Error('sqlite write failed')
  }
  deps.acpProcessPool = {
    checkout: () => null,
    checkin: () => {
      checkinCalled = true
    }
  }

  const result = await runAcpChatThread(deps, {
    runId: 'run-1',
    thread: makeThread(workspacePath),
    requestMessageId: 'msg-req',
    abortController: new AbortController(),
    updateHeadOnComplete: true
  })

  assert.equal(result.kind, 'failed')
  assert.equal(checkinCalled, false)
  assert.ok(signals.includes('SIGKILL'))
})
