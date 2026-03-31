import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { createInMemoryYachiyoStorage } from '../../storage/memoryStorage.ts'
import { runAcpChatThread } from './acpChatRuntime.ts'
import type { AcpChatRunDeps, AcpChatRunInput } from './acpChatRuntime.ts'
import type { MessageRecord, SettingsConfig, ThreadRecord } from '../../../../shared/yachiyo/protocol.ts'
import type { YachiyoServerEvent } from '../../../../shared/yachiyo/protocol.ts'

function makeThread(workspacePath: string): ThreadRecord {
  return {
    id: 'thread-1',
    title: 'Test thread',
    updatedAt: '2026-01-01T00:00:00.000Z',
    runtimeBinding: {
      kind: 'acp',
      profileId: 'agent-1',
      profileName: 'Test Agent',
      sessionStatus: 'new'
    },
    workspacePath
  }
}

function makeProfile() {
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

function makeConfig(workspacePath: string): SettingsConfig {
  return {
    apiKey: '',
    providerName: '',
    model: '',
    enabledTools: [],
    providers: [],
    subagentProfiles: [makeProfile()]
  } as unknown as SettingsConfig
}

function makeDeps(workspacePath: string): AcpChatRunDeps & { storage: ReturnType<typeof createInMemoryYachiyoStorage> } {
  const storage = createInMemoryYachiyoStorage()
  const thread = makeThread(workspacePath)
  const requestMessage: MessageRecord = {
    id: 'msg-req',
    threadId: thread.id,
    role: 'user',
    content: 'hello',
    status: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z'
  }

  storage.createThread({ thread, createdAt: '2026-01-01T00:00:00.000Z', messages: [requestMessage] })
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
    emit: <T extends YachiyoServerEvent>(event: T) => { emittedEvents.push(event) },
    readThread: (threadId: string) => {
      const t = storage.getThread(threadId)
      if (!t) throw new Error(`Thread ${threadId} not found`)
      return t
    },
    readConfig: () => makeConfig(workspacePath),
    loadThreadMessages: (threadId: string) => storage.listThreadMessages(threadId),
    ensureThreadWorkspace: async () => workspacePath,
    emittedEvents
  } as AcpChatRunDeps & { storage: ReturnType<typeof createInMemoryYachiyoStorage>; emittedEvents: YachiyoServerEvent[] }
}

test('runAcpChatThread cancel: calls storage.cancelRun when aborted before ACP session starts', async () => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'acp-test-'))

  const deps = makeDeps(workspacePath) as ReturnType<typeof makeDeps> & { emittedEvents: YachiyoServerEvent[] }

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

// The fail path (process errors) is covered by code inspection: the catch block now calls
// storage.saveThreadMessage + storage.failRun instead of the previous storage.completeRun.
// That path requires spawning a real login-shell process and is covered by manual testing.
