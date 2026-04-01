import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { createInMemoryYachiyoStorage } from '../../storage/memoryStorage.ts'
import { runAcpChatThread } from './acpChatRuntime.ts'
import type { AcpChatRunDeps, AcpChatRunInput } from './acpChatRuntime.ts'
import type { AcpLaunchResult } from './acpLauncher.ts'
import type {
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

  const storedThread = deps.storage.getThread('thread-1')
  assert.equal(storedThread?.preview, 'partial reply')
  assert.equal(
    deps.emittedEvents.some(
      (event) => event.type === 'message.completed' && event.message.status === 'stopped'
    ),
    true
  )
})
