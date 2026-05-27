import assert from 'node:assert/strict'
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { YachiyoServer } from '../YachiyoServer.ts'
import { RetryableRunError } from '../../../runtime/models/runtimeErrors.ts'
import type { ModelStreamRequest } from '../../../runtime/models/types.ts'
import type { SoulDocument } from '../../../runtime/profiles/soul.ts'
import { readUserDocument, writeUserDocument } from '../../../runtime/profiles/user.ts'
import { createInMemoryYachiyoStorage } from '../../../storage/memoryStorage.ts'
import type { MemoryService } from '../../../services/memory/memoryService.ts'
import type {
  ChatAccepted,
  ChatAcceptedWithUserMessage,
  UserDocument,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'

function assertAcceptedHasUserMessage(
  accepted: ChatAccepted
): asserts accepted is ChatAcceptedWithUserMessage {
  assert.ok('userMessage' in accepted)
}

async function withServer(
  fn: (input: {
    server: YachiyoServer
    storage: ReturnType<typeof createInMemoryYachiyoStorage>
    completeRun: (runId: string) => Promise<void>
    modelRequests: ModelStreamRequest[]
    waitForEvent: (type: string) => Promise<unknown>
    workspacePathForThread: (threadId: string) => string
  }) => Promise<void>,
  options: {
    createModelRuntime?: () => {
      streamReply(request: ModelStreamRequest): AsyncIterable<string>
    }
    readSoulDocument?: () => Promise<SoulDocument | null>
    readUserDocument?: () => Promise<UserDocument | null>
    saveUserDocument?: (content: string) => Promise<UserDocument | null>
    ensureThreadWorkspace?: (
      threadId: string,
      workspacePathForThread: (threadId: string) => string
    ) => Promise<string>
    cloneThreadWorkspace?: (
      sourceThreadId: string,
      targetThreadId: string,
      workspacePathForThread: (threadId: string) => string
    ) => Promise<string>
    deleteThreadWorkspace?: (
      threadId: string,
      workspacePathForThread: (threadId: string) => string
    ) => Promise<void>
    memoryService?: MemoryService
    now?: () => Date
    jotdownStore?: import('../../../services/jotdownStore.ts').JotdownStore
  } = {}
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-test-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(settingsPath, '[toolModel]\nmode = "disabled"\n', 'utf8')
  const userDocumentPath = join(root, '.yachiyo', 'USER.md')
  const storage = createInMemoryYachiyoStorage()
  const modelRequests: ModelStreamRequest[] = []
  const workspacePathForThread = (threadId: string): string =>
    join(root, '.yachiyo', 'temp-workspace', threadId)

  const waiters = new Map<string, Array<{ id: number; handle: (value: unknown) => boolean }>>()
  const seenEvents = new Map<string, unknown[]>()
  let nextWaiterId = 0

  const enqueueWaiter = (type: string, handle: (value: unknown) => boolean): (() => void) => {
    const queue = waiters.get(type) ?? []
    const waiter = { id: nextWaiterId++, handle }
    queue.push(waiter)
    waiters.set(type, queue)

    return () => {
      const currentQueue = waiters.get(type)
      if (!currentQueue) {
        return
      }

      const nextQueue = currentQueue.filter((entry) => entry.id !== waiter.id)
      if (nextQueue.length === 0) {
        waiters.delete(type)
        return
      }

      waiters.set(type, nextQueue)
    }
  }

  const settle = (type: string, value: unknown): void => {
    const queue = waiters.get(type)
    if (!queue || queue.length === 0) {
      const seen = seenEvents.get(type) ?? []
      seen.push(value)
      seenEvents.set(type, seen)
      return
    }

    for (const waiter of [...queue]) {
      if (!waiter.handle(value)) {
        continue
      }

      const nextQueue = (waiters.get(type) ?? []).filter((entry) => entry.id !== waiter.id)
      if (nextQueue.length === 0) {
        waiters.delete(type)
      } else {
        waiters.set(type, nextQueue)
      }
      return
    }

    const seen = seenEvents.get(type) ?? []
    seen.push(value)
    seenEvents.set(type, seen)
  }

  const takeSeenEvent = <T>(type: string, predicate: (value: T) => boolean): T | undefined => {
    const queue = seenEvents.get(type)
    if (!queue || queue.length === 0) {
      return undefined
    }

    const index = queue.findIndex((value) => predicate(value as T))
    if (index < 0) {
      return undefined
    }

    const [value] = queue.splice(index, 1)
    return value as T
  }

  const server = new YachiyoServer({
    storage,
    settingsPath,
    now: options.now,
    ensureThreadWorkspace:
      (options.ensureThreadWorkspace
        ? (threadId) => options.ensureThreadWorkspace!(threadId, workspacePathForThread)
        : undefined) ??
      (async (threadId) => {
        const workspacePath = workspacePathForThread(threadId)
        await mkdir(workspacePath, { recursive: true })
        return workspacePath
      }),
    cloneThreadWorkspace:
      (options.cloneThreadWorkspace
        ? (sourceThreadId, targetThreadId) =>
            options.cloneThreadWorkspace!(sourceThreadId, targetThreadId, workspacePathForThread)
        : undefined) ??
      (async (sourceThreadId, targetThreadId) => {
        const sourceWorkspacePath = workspacePathForThread(sourceThreadId)
        const targetWorkspacePath = workspacePathForThread(targetThreadId)
        const sourceExists = await access(sourceWorkspacePath).then(
          () => true,
          () => false
        )
        if (!sourceExists) {
          await mkdir(targetWorkspacePath, { recursive: true })
          return targetWorkspacePath
        }
        await cp(sourceWorkspacePath, targetWorkspacePath, {
          recursive: true,
          force: true
        })
        return targetWorkspacePath
      }),
    deleteThreadWorkspace:
      (options.deleteThreadWorkspace
        ? (threadId) => options.deleteThreadWorkspace!(threadId, workspacePathForThread)
        : undefined) ??
      (async (threadId) => {
        await rm(workspacePathForThread(threadId), { recursive: true, force: true })
      }),
    createModelRuntime:
      options.createModelRuntime ??
      (() => ({
        async *streamReply(request: ModelStreamRequest) {
          modelRequests.push(request)

          const lastMessage = request.messages.at(-1)
          const lastMessageText =
            typeof lastMessage?.content === 'string'
              ? lastMessage.content
              : (lastMessage?.content
                  .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
                  .map((part) => part.text)
                  .join('') ?? '')

          if (lastMessageText.includes('cancel me')) {
            yield 'Partial'
            await new Promise((_, reject) => {
              const abort = (): void => {
                const error = new Error('Aborted')
                error.name = 'AbortError'
                reject(error)
              }

              if (request.signal.aborted) {
                abort()
                return
              }

              request.signal.addEventListener('abort', abort, { once: true })
            })
            return
          }

          yield 'Hello'
          yield ' world'
        }
      })),
    readSoulDocument: options.readSoulDocument ?? (async () => null),
    readUserDocument:
      options.readUserDocument ?? (() => readUserDocument({ filePath: userDocumentPath })),
    saveUserDocument:
      options.saveUserDocument ??
      ((content) => writeUserDocument({ filePath: userDocumentPath, content })),
    memoryService: options.memoryService,
    jotdownStore: options.jotdownStore
  })

  const unsubscribe = server.subscribe((event) => {
    settle(event.type, event)
  })

  try {
    await fn({
      server,
      storage,
      workspacePathForThread,
      completeRun: (runId) =>
        new Promise<void>((resolve, reject) => {
          const completed = takeSeenEvent<{ runId: string }>(
            'run.completed',
            (event) => event.runId === runId
          )
          if (completed) {
            resolve()
            return
          }

          const failed = takeSeenEvent<{ runId: string; error: string }>(
            'run.failed',
            (event) => event.runId === runId
          )
          if (failed) {
            reject(new Error(failed.error))
            return
          }

          const cancelled = takeSeenEvent<{ runId: string }>(
            'run.cancelled',
            (event) => event.runId === runId
          )
          if (cancelled) {
            resolve()
            return
          }

          const cleanups: Array<() => void> = []
          let settled = false

          const finalize = (fn: () => void): boolean => {
            if (settled) {
              return true
            }

            settled = true
            for (const cleanup of cleanups) {
              cleanup()
            }
            fn()
            return true
          }

          cleanups.push(
            enqueueWaiter('run.completed', (event) => {
              const payload = event as { runId: string }
              if (payload.runId !== runId) {
                return false
              }

              return finalize(resolve)
            })
          )
          cleanups.push(
            enqueueWaiter('run.failed', (event) => {
              const payload = event as { runId: string; error: string }
              if (payload.runId !== runId) {
                return false
              }

              return finalize(() => reject(new Error(payload.error)))
            })
          )
          cleanups.push(
            enqueueWaiter('run.cancelled', (event) => {
              const payload = event as { runId: string }
              if (payload.runId !== runId) {
                return false
              }

              return finalize(resolve)
            })
          )
        }),
      modelRequests,
      waitForEvent: (type) =>
        new Promise((resolve) => {
          const seen = seenEvents.get(type)
          if (seen && seen.length > 0) {
            resolve(seen.shift())
            return
          }

          enqueueWaiter(type, (event) => {
            resolve(event)
            return true
          })
        })
    })
  } finally {
    unsubscribe()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}

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

test('YachiyoServer merges stale checkpoint transcripts with completed delegated tool rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-recover-stale-checkpoint-test-'))
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
          content: 'Resume the delegation work.',
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
      id: 'tool-delegate-1',
      runId: 'run-1',
      threadId: 'thread-1',
      requestMessageId: 'user-1',
      toolName: 'delegateCodingTask',
      status: 'completed',
      inputSummary: 'Worker 1',
      outputSummary: 'done',
      startedAt: createdAt,
      finishedAt: interruptedAt
    })
    storage.upsertRunRecoveryCheckpoint({
      runId: 'run-1',
      threadId: 'thread-1',
      requestMessageId: 'user-1',
      assistantMessageId: 'assistant-recovery-1',
      content: 'Before delegation. ',
      responseMessages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Before delegation. ' },
            {
              type: 'tool-call',
              toolCallId: 'tool-stale-running-1',
              toolName: 'bash',
              input: { command: 'pwd' }
            }
          ]
        }
      ],
      enabledTools: ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'webRead', 'webSearch'],
      runTrigger: 'local',
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

    try {
      await resumedServer.bootstrap()
      await waiter.waitForEvent('run.completed', (event) => event.runId === 'run-1')

      const recoveryMessages = resumedRequests[0]?.messages ?? []
      assert.ok(
        recoveryMessages.some(
          (message) =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) =>
                part.type === 'tool-call' &&
                part.toolCallId === 'tool-delegate-1' &&
                part.toolName === 'delegateCodingTask'
            )
        )
      )
      assert.ok(
        recoveryMessages.some(
          (message) =>
            message.role === 'tool' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) =>
                part.type === 'tool-result' &&
                part.toolCallId === 'tool-delegate-1' &&
                part.toolName === 'delegateCodingTask'
            )
        )
      )
      assert.equal(
        recoveryMessages.some(
          (message) =>
            Array.isArray(message.content) &&
            message.content.some(
              (part) => 'toolCallId' in part && part.toolCallId === 'tool-stale-running-1'
            )
        ),
        false
      )
    } finally {
      waiter.close()
      await resumedServer.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('YachiyoServer replays a matching tool-call when recovery only saw a finish event', async () => {
  const requests: ModelStreamRequest[] = []
  let attempt = 0

  await withServer(
    async ({ server, completeRun }) => {
      await server.upsertProvider({
        name: 'work',
        type: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        modelList: {
          enabled: ['gpt-5'],
          disabled: []
        }
      })

      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Recover a finish-only tool event.'
      })
      assertAcceptedHasUserMessage(accepted)

      await completeRun(accepted.runId)

      assert.equal(requests.length, 2)
      const recoveryMessages = requests[1]?.messages ?? []
      const assistantWithToolCall = recoveryMessages.find(
        (message) =>
          message.role === 'assistant' &&
          Array.isArray(message.content) &&
          message.content.some(
            (part) =>
              part.type === 'tool-call' &&
              part.toolCallId === 'tool-finish-only-1' &&
              part.toolName === 'bash'
          )
      )
      const toolResultMessage = recoveryMessages.find(
        (message) =>
          message.role === 'tool' &&
          Array.isArray(message.content) &&
          message.content.some(
            (part) =>
              part.type === 'tool-result' &&
              part.toolCallId === 'tool-finish-only-1' &&
              part.toolName === 'bash'
          )
      )

      assert.ok(assistantWithToolCall)
      assert.ok(toolResultMessage)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (attempt === 0) {
            attempt += 1

            yield 'Checking. '

            request.onToolCallFinish?.({
              abortSignal: request.signal,
              durationMs: 3,
              experimental_context: undefined,
              functionId: undefined,
              messages: request.messages,
              metadata: undefined,
              model: undefined,
              stepNumber: 0,
              success: true,
              output: {
                content: [{ type: 'text', text: '/tmp/workspace\n' }],
                details: {
                  command: 'pwd',
                  cwd: '/tmp/workspace',
                  exitCode: 0,
                  stderr: '',
                  stdout: '/tmp/workspace\n'
                },
                metadata: {
                  cwd: '/tmp/workspace',
                  exitCode: 0
                }
              },
              toolCall: {
                input: { command: 'pwd' },
                toolCallId: 'tool-finish-only-1',
                toolName: 'bash'
              }
            } as never)

            const cause = Object.assign(new Error('net::ERR_CONNECTION_CLOSED'), { status: 0 })
            throw new RetryableRunError('net::ERR_CONNECTION_CLOSED', { cause })
          }

          yield 'Final answer.'
        }
      })
    }
  )
})

test('YachiyoServer keeps recovered response history when the provider retries mid-resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-recover-retry-history-test-'))
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
          content: 'Resume and survive an internal retry.',
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
      content: 'Recovered prefix. ',
      responseMessages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Recovered prefix. ' }]
        }
      ],
      enabledTools: ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'webRead', 'webSearch'],
      runTrigger: 'local',
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
          yield 'Continued. '

          request.onToolCallStart?.({
            abortSignal: request.signal,
            experimental_context: undefined,
            functionId: undefined,
            messages: request.messages,
            metadata: undefined,
            model: undefined,
            stepNumber: 0,
            toolCall: {
              input: { command: 'pwd' },
              toolCallId: 'tool-retry-history-1',
              toolName: 'bash'
            }
          } as never)

          request.onToolCallFinish?.({
            abortSignal: request.signal,
            durationMs: 3,
            experimental_context: undefined,
            functionId: undefined,
            messages: request.messages,
            metadata: undefined,
            model: undefined,
            stepNumber: 0,
            success: true,
            output: {
              content: [{ type: 'text', text: '/tmp/workspace\n' }],
              details: {
                command: 'pwd',
                cwd: '/tmp/workspace',
                exitCode: 0,
                stderr: '',
                stdout: '/tmp/workspace\n'
              },
              metadata: {
                cwd: '/tmp/workspace',
                exitCode: 0
              }
            },
            toolCall: {
              input: { command: 'pwd' },
              toolCallId: 'tool-retry-history-1',
              toolName: 'bash'
            }
          } as never)

          request.onRetry?.(1, 10, 1000, new Error('net::ERR_CONNECTION_CLOSED'))
          yield 'After retry.'
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
      await waiter.waitForEvent('run.completed', (event) => event.runId === 'run-1')

      const bootstrap = await resumedServer.bootstrap()
      const finalAssistant = (bootstrap.messagesByThread['thread-1'] ?? []).find(
        (message) => message.role === 'assistant' && message.parentMessageId === 'user-1'
      )
      const responseMessages = finalAssistant?.responseMessages as
        | Array<{
            role?: string
            content?: Array<{ type?: string; text?: string; toolCallId?: string }>
          }>
        | undefined

      assert.equal(finalAssistant?.content, 'Recovered prefix. Continued. After retry.')
      assert.ok(
        responseMessages?.some(
          (message) =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) => part.type === 'text' && part.text?.includes('Continued.') === true
            )
        )
      )
      assert.ok(
        responseMessages?.some(
          (message) =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some((part) => part.type === 'text' && part.text === 'After retry.')
        )
      )
      assert.ok(
        responseMessages?.some(
          (message) =>
            message.role === 'tool' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) => part.type === 'tool-result' && part.toolCallId === 'tool-retry-history-1'
            )
        )
      )
    } finally {
      waiter.close()
      await resumedServer.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
