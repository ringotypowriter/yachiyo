import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { YachiyoServer } from './YachiyoServer.ts'
import { RETRY_MAX_ATTEMPTS } from '../runtime/modelRuntime.ts'
import type { ModelStreamRequest } from '../runtime/types.ts'
import { readUserDocument, writeUserDocument } from '../runtime/user.ts'
import { createInMemoryYachiyoStorage } from '../storage/memoryStorage.ts'
import type { YachiyoServerEvent } from '../../../shared/yachiyo/protocol.ts'

function createServerEventWaiter(server: YachiyoServer): {
  close: () => void
  waitForEvent: <TType extends YachiyoServerEvent['type']>(
    type: TType,
    predicate?: (event: Extract<YachiyoServerEvent, { type: TType }>) => boolean
  ) => Promise<Extract<YachiyoServerEvent, { type: TType }>>
} {
  const seenEvents = new Map<string, unknown[]>()
  const waiters = new Map<
    string,
    Array<{
      id: number
      predicate: (event: unknown) => boolean
      resolve: (event: unknown) => void
    }>
  >()
  let nextWaiterId = 0

  const unsubscribe = server.subscribe((event) => {
    const queue = waiters.get(event.type)
    if (!queue || queue.length === 0) {
      const seen = seenEvents.get(event.type) ?? []
      seen.push(event)
      seenEvents.set(event.type, seen)
      return
    }

    for (const waiter of [...queue]) {
      if (!waiter.predicate(event)) {
        continue
      }

      const nextQueue = (waiters.get(event.type) ?? []).filter((entry) => entry.id !== waiter.id)
      if (nextQueue.length === 0) {
        waiters.delete(event.type)
      } else {
        waiters.set(event.type, nextQueue)
      }
      waiter.resolve(event)
      return
    }

    const seen = seenEvents.get(event.type) ?? []
    seen.push(event)
    seenEvents.set(event.type, seen)
  })

  return {
    close: unsubscribe,
    waitForEvent: <TType extends YachiyoServerEvent['type']>(
      type: TType,
      predicate: (event: Extract<YachiyoServerEvent, { type: TType }>) => boolean = () => true
    ): Promise<Extract<YachiyoServerEvent, { type: TType }>> => {
      const seen = seenEvents.get(type) ?? []
      const index = seen.findIndex((event) =>
        predicate(event as Extract<YachiyoServerEvent, { type: TType }>)
      )
      if (index >= 0) {
        const [event] = seen.splice(index, 1)
        return Promise.resolve(event as Extract<YachiyoServerEvent, { type: TType }>)
      }

      return new Promise((resolve) => {
        const queue = waiters.get(type) ?? []
        queue.push({
          id: nextWaiterId++,
          predicate: (event) => predicate(event as Extract<YachiyoServerEvent, { type: TType }>),
          resolve: (event) => resolve(event as Extract<YachiyoServerEvent, { type: TType }>)
        })
        waiters.set(type, queue)
      })
    }
  }
}

test('YachiyoServer bootstrap recovers interrupted runs and marks running tool calls as failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-recover-test-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(settingsPath, '[toolModel]\nmode = "disabled"\n', 'utf8')
  const userDocumentPath = join(root, '.yachiyo', 'USER.md')
  const storage = createInMemoryYachiyoStorage()
  const createdAt = '2026-03-16T09:00:00.000Z'
  const interruptedAt = '2026-03-17T09:30:00.000Z'

  storage.createThread({
    thread: {
      id: 'thread-1',
      title: 'Interrupted thread',
      updatedAt: createdAt,
      headMessageId: 'user-1'
    },
    createdAt,
    messages: [
      {
        id: 'user-1',
        threadId: 'thread-1',
        role: 'user',
        content: 'Do the thing',
        status: 'completed',
        createdAt
      }
    ]
  })
  storage.startRun({
    runId: 'run-1',
    thread: {
      id: 'thread-1',
      title: 'Interrupted thread',
      updatedAt: createdAt,
      headMessageId: 'user-1'
    },
    updatedThread: {
      id: 'thread-1',
      title: 'Interrupted thread',
      updatedAt: createdAt,
      headMessageId: 'user-1'
    },
    requestMessageId: 'user-1',
    createdAt
  })
  storage.createToolCall({
    id: 'tool-1',
    runId: 'run-1',
    threadId: 'thread-1',
    requestMessageId: 'user-1',
    toolName: 'bash',
    status: 'running',
    inputSummary: 'pwd',
    startedAt: createdAt
  })

  const server = new YachiyoServer({
    storage,
    settingsPath,
    readSoulDocument: async () => null,
    readUserDocument: () => readUserDocument({ filePath: userDocumentPath }),
    saveUserDocument: (content) => writeUserDocument({ filePath: userDocumentPath, content }),
    now: () => new Date(interruptedAt)
  })

  try {
    const bootstrap = await server.bootstrap()

    assert.deepEqual(bootstrap.latestRunsByThread['thread-1'], {
      id: 'run-1',
      threadId: 'thread-1',
      status: 'failed',
      error: 'Run interrupted before completion.',
      requestMessageId: 'user-1',
      createdAt,
      completedAt: interruptedAt
    })
    assert.equal(bootstrap.toolCallsByThread['thread-1']?.[0]?.status, 'failed')
    assert.equal(bootstrap.toolCallsByThread['thread-1']?.[0]?.requestMessageId, 'user-1')
    assert.equal(bootstrap.toolCallsByThread['thread-1']?.[0]?.assistantMessageId, undefined)
    assert.equal(
      bootstrap.toolCallsByThread['thread-1']?.[0]?.outputSummary,
      'Run interrupted before completion.'
    )
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('YachiyoServer bootstrap resumes an interrupted run from its persisted recovery checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-recover-resume-test-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(settingsPath, '[toolModel]\nmode = "disabled"\n', 'utf8')
  const userDocumentPath = join(root, '.yachiyo', 'USER.md')
  const workspacePathForThread = (threadId: string): string =>
    join(root, '.yachiyo', 'temp-workspace', threadId)
  const storage = createInMemoryYachiyoStorage()
  const createdAt = '2026-03-16T09:00:00.000Z'
  const interruptedAt = '2026-03-17T09:30:00.000Z'

  try {
    await mkdir(workspacePathForThread('thread-1'), { recursive: true })

    storage.createThread({
      thread: {
        id: 'thread-1',
        title: 'Interrupted thread',
        updatedAt: createdAt,
        headMessageId: 'user-1'
      },
      createdAt,
      messages: [
        {
          id: 'user-1',
          threadId: 'thread-1',
          role: 'user',
          content: 'Inspect the workspace and finish the answer.',
          status: 'completed',
          createdAt
        }
      ]
    })
    storage.startRun({
      runId: 'run-1',
      thread: {
        id: 'thread-1',
        title: 'Interrupted thread',
        updatedAt: createdAt,
        headMessageId: 'user-1'
      },
      updatedThread: {
        id: 'thread-1',
        title: 'Interrupted thread',
        updatedAt: createdAt,
        headMessageId: 'user-1'
      },
      requestMessageId: 'user-1',
      createdAt
    })
    storage.createToolCall({
      id: 'tool-bash-bootstrap-1',
      runId: 'run-1',
      threadId: 'thread-1',
      requestMessageId: 'user-1',
      toolName: 'bash',
      status: 'completed',
      inputSummary: 'pwd',
      outputSummary: 'exit 0',
      cwd: '/tmp/workspace',
      details: {
        command: 'pwd',
        cwd: '/tmp/workspace',
        exitCode: 0,
        stderr: '',
        stdout: '/tmp/workspace\n'
      },
      startedAt: createdAt,
      finishedAt: createdAt
    })
    storage.upsertRunRecoveryCheckpoint({
      runId: 'run-1',
      threadId: 'thread-1',
      requestMessageId: 'user-1',
      assistantMessageId: 'assistant-recovery-1',
      content: 'Before tool. After tool. ',
      responseMessages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Before tool. ' },
            {
              type: 'tool-call',
              toolCallId: 'tool-bash-bootstrap-1',
              toolName: 'bash',
              input: { command: 'pwd' }
            }
          ]
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'tool-bash-bootstrap-1',
              toolName: 'bash',
              output: {
                type: 'content',
                value: [{ type: 'text', text: '/tmp/workspace\n' }]
              }
            }
          ]
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'After tool. ' }]
        }
      ],
      enabledTools: ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'webRead', 'webSearch'],
      updateHeadOnComplete: true,
      createdAt,
      updatedAt: interruptedAt,
      recoveryAttempts: 1,
      lastError: 'net::ERR_CONNECTION_CLOSED'
    })

    const resumedServer = new YachiyoServer({
      storage,
      settingsPath,
      now: () => new Date(interruptedAt),
      readSoulDocument: async () => null,
      readUserDocument: () => readUserDocument({ filePath: userDocumentPath }),
      saveUserDocument: (content) => writeUserDocument({ filePath: userDocumentPath, content }),
      ensureThreadWorkspace: async (threadId) => {
        const workspacePath = workspacePathForThread(threadId)
        await mkdir(workspacePath, { recursive: true })
        return workspacePath
      },
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          resumedRequests.push(request)
          yield 'Final answer.'
        }
      })
    })
    const waiter = createServerEventWaiter(resumedServer)

    await resumedServer.upsertProvider({
      name: 'work',
      type: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      modelList: {
        enabled: ['gpt-5'],
        disabled: []
      }
    })
    const resumedRequests: ModelStreamRequest[] = []

    try {
      await resumedServer.bootstrap()
      await waiter.waitForEvent('run.completed', (event) => event.runId === 'run-1')

      const bootstrap = await resumedServer.bootstrap()
      const finalAssistant = (bootstrap.messagesByThread['thread-1'] ?? []).find(
        (message) => message.role === 'assistant' && message.parentMessageId === 'user-1'
      )

      assert.equal(bootstrap.latestRunsByThread['thread-1']?.status, 'completed')
      assert.equal(resumedRequests.length, 1)
      assert.ok(
        resumedRequests[0]?.messages.some(
          (message) =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.length === 1 &&
            message.content[0]?.type === 'text' &&
            message.content[0]?.text === 'After tool. '
        )
      )
      assert.ok(
        resumedRequests[0]?.messages.some(
          (message) =>
            message.role === 'tool' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) => part.type === 'tool-result' && part.toolCallId === 'tool-bash-bootstrap-1'
            )
        )
      )
      assert.equal(finalAssistant?.content, 'Before tool. After tool. Final answer.')
    } finally {
      waiter.close()
      await resumedServer.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('YachiyoServer stops recovery after the final allowed committed retry attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-recover-limit-test-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(settingsPath, '[toolModel]\nmode = "disabled"\n', 'utf8')
  const userDocumentPath = join(root, '.yachiyo', 'USER.md')
  const workspacePathForThread = (threadId: string): string =>
    join(root, '.yachiyo', 'temp-workspace', threadId)
  const storage = createInMemoryYachiyoStorage()
  const createdAt = '2026-03-16T09:00:00.000Z'
  const interruptedAt = '2026-03-17T09:30:00.000Z'
  const resumedRequests: ModelStreamRequest[] = []

  try {
    await mkdir(workspacePathForThread('thread-1'), { recursive: true })

    storage.createThread({
      thread: {
        id: 'thread-1',
        title: 'Interrupted thread',
        updatedAt: createdAt,
        headMessageId: 'user-1'
      },
      createdAt,
      messages: [
        {
          id: 'user-1',
          threadId: 'thread-1',
          role: 'user',
          content: 'Inspect the workspace and finish the answer.',
          status: 'completed',
          createdAt
        }
      ]
    })
    storage.startRun({
      runId: 'run-1',
      thread: {
        id: 'thread-1',
        title: 'Interrupted thread',
        updatedAt: createdAt,
        headMessageId: 'user-1'
      },
      updatedThread: {
        id: 'thread-1',
        title: 'Interrupted thread',
        updatedAt: createdAt,
        headMessageId: 'user-1'
      },
      requestMessageId: 'user-1',
      createdAt
    })
    storage.upsertRunRecoveryCheckpoint({
      runId: 'run-1',
      threadId: 'thread-1',
      requestMessageId: 'user-1',
      assistantMessageId: 'assistant-recovery-1',
      content: 'Checking the workspace. ',
      enabledTools: ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'webRead', 'webSearch'],
      updateHeadOnComplete: true,
      createdAt,
      updatedAt: interruptedAt,
      recoveryAttempts: RETRY_MAX_ATTEMPTS - 1,
      lastError: 'net::ERR_CONNECTION_CLOSED'
    })

    const resumedServer = new YachiyoServer({
      storage,
      settingsPath,
      now: () => new Date(interruptedAt),
      readSoulDocument: async () => null,
      readUserDocument: () => readUserDocument({ filePath: userDocumentPath }),
      saveUserDocument: (content) => writeUserDocument({ filePath: userDocumentPath, content }),
      ensureThreadWorkspace: async (threadId) => {
        const workspacePath = workspacePathForThread(threadId)
        await mkdir(workspacePath, { recursive: true })
        return workspacePath
      },
      createModelRuntime: () => ({
        streamReply(request: ModelStreamRequest): AsyncIterable<string> {
          resumedRequests.push(request)
          const iterator: AsyncIterator<string> & AsyncIterable<string> = {
            next() {
              const error = new Error('net::ERR_CONNECTION_CLOSED') as Error & { status?: number }
              error.status = 0
              return Promise.reject(error)
            },
            [Symbol.asyncIterator]() {
              return iterator
            }
          }
          return iterator
        }
      })
    })
    const waiter = createServerEventWaiter(resumedServer)

    await resumedServer.upsertProvider({
      name: 'work',
      type: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      modelList: {
        enabled: ['gpt-5'],
        disabled: []
      }
    })

    try {
      await resumedServer.bootstrap()
      await waiter.waitForEvent('run.failed', (event) => event.runId === 'run-1')

      const bootstrap = await resumedServer.bootstrap()

      assert.equal(resumedRequests.length, 1)
      assert.equal(bootstrap.latestRunsByThread['thread-1']?.status, 'failed')
      assert.equal(
        bootstrap.latestRunsByThread['thread-1']?.error,
        'Connection closed unexpectedly'
      )
      assert.equal(storage.getRunRecoveryCheckpoint('run-1'), undefined)
    } finally {
      waiter.close()
      await resumedServer.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
