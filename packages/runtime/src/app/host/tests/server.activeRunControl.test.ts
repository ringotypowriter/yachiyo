import assert from 'node:assert/strict'
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { YachiyoServer } from '../YachiyoServer.ts'
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

async function upsertWorkProvider(server: YachiyoServer): Promise<void> {
  await server.upsertProvider({
    name: 'work',
    type: 'openai',
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    modelList: { enabled: ['gpt-5'], disabled: [] }
  })
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

test('YachiyoServer does not fire a deferred steer point while a later chained tool is already running', async () => {
  const requests: ModelStreamRequest[] = []
  let attempt = 0
  let releaseFirstTool: (() => void) | null = null
  let releaseSecondTool: (() => void) | null = null
  let markFirstToolStarted: (() => void) | null = null
  let markSecondToolStarted: (() => void) | null = null
  const firstToolStarted = new Promise<void>((resolve) => {
    markFirstToolStarted = resolve
  })
  const secondToolStarted = new Promise<void>((resolve) => {
    markSecondToolStarted = resolve
  })

  await withServer(
    async ({ server, completeRun }) => {
      await upsertWorkProvider(server)

      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'List the workspace files.'
      })
      assertAcceptedHasUserMessage(accepted)

      await firstToolStarted

      const steerAccepted = await server.sendChat({
        threadId: thread.id,
        content: 'Actually summarize the result instead',
        mode: 'steer'
      })

      assert.equal(steerAccepted.kind, 'active-run-steer-pending')

      releaseFirstTool?.()
      await secondToolStarted
      await new Promise((resolve) => setTimeout(resolve, 0))

      assert.equal(requests.length, 1)
      assert.equal(requests[0]?.signal.aborted, false)

      releaseSecondTool?.()
      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const toolCalls = bootstrap.toolCallsByThread[thread.id] ?? []

      assert.equal(requests.length, 2)
      assert.equal(toolCalls.length, 2)
      assert.deepEqual(
        toolCalls.map((toolCall) => toolCall.status),
        ['completed', 'completed']
      )
      assert.equal(requests[1]?.messages.at(-1)?.role, 'user')
      assert.ok(
        String(requests[1]?.messages.at(-1)?.content).startsWith(
          'Actually summarize the result instead'
        )
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (attempt === 0) {
            attempt += 1

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
                toolCallId: 'tool-bash-1',
                toolName: 'bash'
              }
            } as never)
            markFirstToolStarted?.()
            markFirstToolStarted = null

            await new Promise<void>((resolve) => {
              releaseFirstTool = resolve
            })

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
                toolCallId: 'tool-bash-1',
                toolName: 'bash'
              }
            } as never)

            request.onToolCallStart?.({
              abortSignal: request.signal,
              experimental_context: undefined,
              functionId: undefined,
              messages: request.messages,
              metadata: undefined,
              model: undefined,
              stepNumber: 1,
              toolCall: {
                input: { command: 'ls' },
                toolCallId: 'tool-bash-2',
                toolName: 'bash'
              }
            } as never)
            markSecondToolStarted?.()
            markSecondToolStarted = null

            await new Promise<void>((resolve) => {
              releaseSecondTool = resolve
            })

            request.onToolCallFinish?.({
              abortSignal: request.signal,
              durationMs: 3,
              experimental_context: undefined,
              functionId: undefined,
              messages: request.messages,
              metadata: undefined,
              model: undefined,
              stepNumber: 1,
              success: true,
              output: {
                content: [{ type: 'text', text: 'file.txt\n' }],
                details: {
                  command: 'ls',
                  cwd: '/tmp/workspace',
                  exitCode: 0,
                  stderr: '',
                  stdout: 'file.txt\n'
                },
                metadata: {
                  cwd: '/tmp/workspace',
                  exitCode: 0
                }
              },
              toolCall: {
                input: { command: 'ls' },
                toolCallId: 'tool-bash-2',
                toolName: 'bash'
              }
            } as never)

            // Stream ends naturally — hasPendingSteer picks up the steer
            return
          }

          yield 'Steered'
          yield ' reply'
        }
      })
    }
  )
})

test('YachiyoServer cancels an active run without persisting partial assistant output', async () => {
  await withServer(async ({ server, completeRun, waitForEvent }) => {
    await server.upsertProvider({
      name: 'backup',
      type: 'anthropic',
      apiKey: 'sk-ant-test',
      baseUrl: '',
      modelList: {
        enabled: ['claude-opus-4-6'],
        disabled: []
      }
    })

    const thread = await server.createThread()
    const accepted = await server.sendChat({
      threadId: thread.id,
      content: 'Please cancel me halfway. cancel me'
    })

    await waitForEvent('message.delta')
    await server.cancelRun({ runId: accepted.runId })
    await completeRun(accepted.runId)

    const bootstrap = await server.bootstrap()
    const messages = bootstrap.messagesByThread[thread.id] ?? []

    assert.equal(messages.length, 2)
    assert.equal(messages[0]?.role, 'user')
    assert.equal(messages[0]?.content, 'Please cancel me halfway. cancel me')
    assert.equal(messages[1]?.role, 'assistant')
    assert.equal(messages[1]?.status, 'stopped')
  })
})

test('YachiyoServer merges additional follow-ups into the queued follow-up for an active run', async () => {
  const requests: ModelStreamRequest[] = []
  let releaseFirstRun: (() => void) | null = null
  let markFirstRunBlocked: (() => void) | null = null
  const firstRunBlocked = new Promise<void>((resolve) => {
    markFirstRunBlocked = resolve
  })

  await withServer(
    async ({ server, storage, completeRun, waitForEvent }) => {
      await upsertWorkProvider(server)

      const thread = await server.createThread()
      const firstRun = await server.sendChat({
        threadId: thread.id,
        content: 'First question'
      })
      const createdRun = (await waitForEvent('run.created')) as { runId: string }

      assert.equal(createdRun.runId, firstRun.runId)
      await waitForEvent('message.delta')
      await firstRunBlocked

      const firstQueued = await server.sendChat({
        threadId: thread.id,
        content: 'First queued follow-up',
        mode: 'follow-up'
      })
      const replacement = await server.sendChat({
        threadId: thread.id,
        content: 'Second queued follow-up',
        mode: 'follow-up'
      })

      assert.equal(firstQueued.kind, 'active-run-follow-up')
      assert.equal(replacement.kind, 'active-run-follow-up')
      assert.equal(replacement.replacedMessageId, firstQueued.userMessage.id)
      assert.equal(replacement.thread.queuedFollowUpMessageId, replacement.userMessage.id)
      try {
        const pendingBootstrap = await server.bootstrap()
        const persistedBootstrap = storage.bootstrap()
        assert.equal(
          pendingBootstrap.threads[0]?.queuedFollowUpMessageId,
          replacement.userMessage.id
        )
        assert.equal(persistedBootstrap.threads[0]?.queuedFollowUpMessageId, undefined)
        assert.deepEqual(
          pendingBootstrap.messagesByThread[thread.id]?.map((message) => message.content),
          ['First question', 'First queued follow-up\nSecond queued follow-up']
        )
        assert.deepEqual(
          persistedBootstrap.messagesByThread[thread.id]?.map((message) => message.content),
          ['First question']
        )
      } finally {
        releaseFirstRun?.()
      }
      await completeRun(firstRun.runId)
      await new Promise((resolve) => setTimeout(resolve, 0))
      assert.equal((await server.bootstrap()).threads[0]?.queuedFollowUpMessageId, undefined)
      const followUpRunCreated = (await waitForEvent('run.created')) as { runId: string }
      await completeRun(followUpRunCreated.runId)

      const bootstrap = await server.bootstrap()

      assert.equal(bootstrap.threads[0]?.queuedFollowUpMessageId, undefined)
      assert.deepEqual(
        (bootstrap.messagesByThread[thread.id] ?? []).map((message) => message.content),
        [
          'First question',
          'Hello world',
          'First queued follow-up\nSecond queued follow-up',
          'Queued follow-up reply'
        ]
      )
      assert.ok(
        String(requests[1]?.messages.at(-1)?.content).startsWith(
          'First queued follow-up\nSecond queued follow-up'
        )
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (requests.length === 1) {
            yield 'Hello'
            await new Promise<void>((resolve) => {
              releaseFirstRun = resolve
              markFirstRunBlocked?.()
              markFirstRunBlocked = null
            })
            yield ' world'
            return
          }

          yield 'Queued follow-up reply'
        }
      })
    }
  )
})

test('YachiyoServer appends a queued follow-up after a later steer branch completes', async () => {
  const requests: ModelStreamRequest[] = []
  let releaseInitialRun: (() => void) | null = null
  let releaseSteerRun: (() => void) | null = null
  let markSteerRunStarted: (() => void) | null = null
  let tick = 0
  const steerRunStarted = new Promise<void>((resolve) => {
    markSteerRunStarted = resolve
  })

  await withServer(
    async ({ server, completeRun, waitForEvent }) => {
      await upsertWorkProvider(server)

      const thread = await server.createThread()
      const firstRun = await server.sendChat({
        threadId: thread.id,
        content: 'Initial request'
      })
      const initialRunCreated = (await waitForEvent('run.created')) as { runId: string }

      assert.equal(initialRunCreated.runId, firstRun.runId)
      await waitForEvent('message.delta')

      const queuedFollowUp = await server.sendChat({
        threadId: thread.id,
        content: 'Queued follow-up',
        mode: 'follow-up'
      })
      const steer = await server.sendChat({
        threadId: thread.id,
        content: 'Steer instruction',
        mode: 'steer'
      })

      assert.equal(queuedFollowUp.kind, 'active-run-follow-up')
      assert.equal(steer.kind, 'active-run-steer-pending')

      releaseInitialRun?.()
      await steerRunStarted
      await waitForEvent('message.delta')

      releaseSteerRun?.()
      await completeRun(firstRun.runId)

      const followUpRunCreated = (await waitForEvent('run.created')) as { runId: string }
      await completeRun(followUpRunCreated.runId)

      const bootstrap = await server.bootstrap()
      const messages = bootstrap.messagesByThread[thread.id] ?? []
      const queuedMessage = messages.find((message) => message.content === 'Queued follow-up')
      const steerReply = messages.find((message) => message.content === 'Steer reply')

      assert.deepEqual(
        messages.map((message) => message.content),
        [
          'Initial request',
          'Initial reply',
          'Steer instruction',
          'Steer reply',
          'Queued follow-up',
          'Follow-up reply'
        ]
      )
      assert.equal(queuedMessage?.parentMessageId, steerReply?.id)
      assert.equal(requests[2]?.messages.at(-1)?.role, 'user')
      assert.ok(String(requests[2]?.messages.at(-1)?.content).startsWith('Queued follow-up'))
    },
    {
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (requests.length === 1) {
            yield 'Initial reply'
            await new Promise<void>((resolve) => {
              releaseInitialRun = resolve
            })
            return
          }

          if (requests.length === 2) {
            markSteerRunStarted?.()
            markSteerRunStarted = null
            yield 'Steer reply'
            await new Promise<void>((resolve) => {
              releaseSteerRun = resolve
            })
            return
          }

          yield 'Follow-up reply'
        }
      })
    }
  )
})

test('YachiyoServer deletes a queued follow-up draft without editing persisted history', async () => {
  const requests: ModelStreamRequest[] = []
  let releaseFirstRun: (() => void) | null = null
  let markFirstRunBlocked: (() => void) | null = null
  const firstRunBlocked = new Promise<void>((resolve) => {
    markFirstRunBlocked = resolve
  })

  await withServer(
    async ({ server, completeRun, waitForEvent }) => {
      await upsertWorkProvider(server)

      const thread = await server.createThread()
      const firstRun = await server.sendChat({
        threadId: thread.id,
        content: 'First question'
      })
      const initialRunCreated = (await waitForEvent('run.created')) as { runId: string }
      assert.equal(initialRunCreated.runId, firstRun.runId)
      await waitForEvent('message.delta')
      await firstRunBlocked

      const queuedFollowUp = await server.sendChat({
        threadId: thread.id,
        content: 'Queued follow-up',
        mode: 'follow-up'
      })
      assertAcceptedHasUserMessage(queuedFollowUp)

      const deleted = await server.deleteMessageFromHere({
        threadId: thread.id,
        messageId: queuedFollowUp.userMessage.id
      })
      assert.equal(deleted.thread.queuedFollowUpMessageId, undefined)
      assert.deepEqual(
        deleted.messages.map((message) => message.content),
        ['First question']
      )

      releaseFirstRun?.()
      await completeRun(firstRun.runId)
      await new Promise((resolve) => setTimeout(resolve, 0))

      const bootstrap = await server.bootstrap()
      assert.equal(bootstrap.threads[0]?.queuedFollowUpMessageId, undefined)
      assert.deepEqual(
        (bootstrap.messagesByThread[thread.id] ?? []).map((message) => message.content),
        ['First question', 'Hello world']
      )
      assert.equal(requests.length, 1)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)
          yield 'Hello'
          await new Promise<void>((resolve) => {
            releaseFirstRun = resolve
            markFirstRunBlocked?.()
            markFirstRunBlocked = null
          })
          yield ' world'
        }
      })
    }
  )
})

test('YachiyoServer resends the same queued follow-up after deleting its draft', async () => {
  const requests: ModelStreamRequest[] = []
  let releaseFirstRun: (() => void) | null = null
  let markFirstRunBlocked: (() => void) | null = null
  const firstRunBlocked = new Promise<void>((resolve) => {
    markFirstRunBlocked = resolve
  })

  await withServer(
    async ({ server, completeRun, waitForEvent }) => {
      await upsertWorkProvider(server)

      const thread = await server.createThread()
      const firstRun = await server.sendChat({
        threadId: thread.id,
        content: 'First question'
      })
      const initialRunCreated = (await waitForEvent('run.created')) as { runId: string }
      assert.equal(initialRunCreated.runId, firstRun.runId)
      await waitForEvent('message.delta')
      await firstRunBlocked

      const firstQueuedFollowUp = await server.sendChat({
        threadId: thread.id,
        content: 'Queued follow-up',
        mode: 'follow-up'
      })
      assertAcceptedHasUserMessage(firstQueuedFollowUp)

      await server.deleteMessageFromHere({
        threadId: thread.id,
        messageId: firstQueuedFollowUp.userMessage.id
      })

      const resentQueuedFollowUp = await server.sendChat({
        threadId: thread.id,
        content: 'Queued follow-up',
        mode: 'follow-up'
      })
      assertAcceptedHasUserMessage(resentQueuedFollowUp)
      assert.notEqual(resentQueuedFollowUp.userMessage.id, firstQueuedFollowUp.userMessage.id)

      releaseFirstRun?.()
      await completeRun(firstRun.runId)
      const followUpRunCreated = (await waitForEvent('run.created')) as { runId: string }
      await completeRun(followUpRunCreated.runId)

      const bootstrap = await server.bootstrap()
      assert.deepEqual(
        (bootstrap.messagesByThread[thread.id] ?? []).map((message) => message.content),
        ['First question', 'Hello world', 'Queued follow-up', 'Queued follow-up reply']
      )
      assert.equal(requests.length, 2)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (requests.length === 1) {
            yield 'Hello'
            await new Promise<void>((resolve) => {
              releaseFirstRun = resolve
              markFirstRunBlocked?.()
              markFirstRunBlocked = null
            })
            yield ' world'
            return
          }

          yield 'Queued follow-up reply'
        }
      })
    }
  )
})

test('YachiyoServer preserves a queued follow-up draft across later thread snapshots', async () => {
  let releaseFirstRun: (() => void) | null = null
  let markFirstRunBlocked: (() => void) | null = null
  let requestCount = 0
  const firstRunBlocked = new Promise<void>((resolve) => {
    markFirstRunBlocked = resolve
  })

  await withServer(
    async ({ server, storage, completeRun, waitForEvent }) => {
      await upsertWorkProvider(server)

      const thread = await server.createThread()
      const firstRun = await server.sendChat({
        threadId: thread.id,
        content: 'First question'
      })
      const initialRunCreated = (await waitForEvent('run.created')) as { runId: string }
      assert.equal(initialRunCreated.runId, firstRun.runId)
      await waitForEvent('message.delta')
      await firstRunBlocked

      const queuedFollowUp = await server.sendChat({
        threadId: thread.id,
        content: 'Queued follow-up',
        mode: 'follow-up'
      })
      assertAcceptedHasUserMessage(queuedFollowUp)

      const waiter = createServerEventWaiter(server)
      const renamedEventPromise = waiter.waitForEvent(
        'thread.updated',
        (event) => event.threadId === thread.id && event.thread.title === 'Renamed thread'
      )
      await server.renameThread({ threadId: thread.id, title: 'Renamed thread' })
      const renamedEvent = await renamedEventPromise
      waiter.close()

      const visibleBootstrap = await server.bootstrap()
      const persistedBootstrap = storage.bootstrap()
      const visibleThread = visibleBootstrap.threads.find((entry) => entry.id === thread.id)
      const persistedThread = persistedBootstrap.threads.find((entry) => entry.id === thread.id)
      const visibleMessages = visibleBootstrap.messagesByThread[thread.id] ?? []
      const persistedMessages = persistedBootstrap.messagesByThread[thread.id] ?? []

      releaseFirstRun?.()
      await completeRun(firstRun.runId)
      const followUpRunCreated = (await waitForEvent('run.created')) as { runId: string }
      await completeRun(followUpRunCreated.runId)

      assert.equal(renamedEvent.thread.queuedFollowUpMessageId, queuedFollowUp.userMessage.id)
      assert.equal(visibleThread?.queuedFollowUpMessageId, queuedFollowUp.userMessage.id)
      assert.equal(persistedThread?.queuedFollowUpMessageId, undefined)
      assert.deepEqual(
        visibleMessages.map((message) => message.content),
        ['First question', 'Queued follow-up']
      )
      assert.deepEqual(
        persistedMessages.map((message) => message.content),
        ['First question']
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply() {
          requestCount += 1
          if (requestCount > 1) {
            yield 'Queued follow-up reply'
            return
          }

          yield 'Hello'
          await new Promise<void>((resolve) => {
            releaseFirstRun = resolve
            markFirstRunBlocked?.()
            markFirstRunBlocked = null
          })
          yield ' world'
        }
      })
    }
  )
})

test('YachiyoServer emits a replacement snapshot when a queued follow-up is reparented onto the completed reply branch', async () => {
  let releaseRetryRun: (() => void) | null = null
  let requestCount = 0

  await withServer(
    async ({ server, completeRun, waitForEvent }) => {
      const waiter = createServerEventWaiter(server)
      try {
        await upsertWorkProvider(server)

        const thread = await server.createThread()
        const firstRun = await server.sendChat({
          threadId: thread.id,
          content: 'First question'
        })
        const firstCreated = (await waitForEvent('run.created')) as { runId: string }

        assert.equal(firstCreated.runId, firstRun.runId)
        await waitForEvent('message.delta')
        await completeRun(firstRun.runId)

        const firstBootstrap = await server.bootstrap()
        const firstUserMessage = (firstBootstrap.messagesByThread[thread.id] ?? []).find(
          (message) => message.role === 'user'
        )

        assert.ok(firstUserMessage)

        const retryAccepted = await server.retryMessage({
          threadId: thread.id,
          messageId: firstUserMessage.id
        })
        const retryCreated = (await waitForEvent('run.created')) as { runId: string }

        assert.equal(retryCreated.runId, retryAccepted.runId)
        await waitForEvent('message.delta')

        const queuedFollowUp = await server.sendChat({
          threadId: thread.id,
          content: 'Follow the retry branch',
          mode: 'follow-up'
        })
        assertAcceptedHasUserMessage(queuedFollowUp)

        assert.equal(queuedFollowUp.userMessage.parentMessageId, firstUserMessage.id)

        const replacementEventPromise = waiter.waitForEvent(
          'thread.state.replaced',
          (event) =>
            event.threadId === thread.id &&
            event.messages.some(
              (message) =>
                message.id === queuedFollowUp.userMessage.id &&
                message.parentMessageId !== firstUserMessage.id
            )
        ) as Promise<Extract<YachiyoServerEvent, { type: 'thread.state.replaced' }>>
        const followUpRunCreatedPromise = waiter.waitForEvent(
          'run.created',
          (event) =>
            event.threadId === thread.id && event.requestMessageId === queuedFollowUp.userMessage.id
        ) as Promise<Extract<YachiyoServerEvent, { type: 'run.created' }>>

        releaseRetryRun?.()
        await completeRun(retryAccepted.runId)

        const replacementEvent = await replacementEventPromise
        const reparentedQueuedMessage = replacementEvent.messages.find(
          (message) => message.id === queuedFollowUp.userMessage.id
        )
        const retryAssistantMessage = replacementEvent.messages.find(
          (message) => message.role === 'assistant' && message.content === 'Retry reply'
        )

        assert.ok(retryAssistantMessage)
        assert.equal(reparentedQueuedMessage?.parentMessageId, retryAssistantMessage.id)

        const followUpRunCreated = await followUpRunCreatedPromise
        await completeRun(followUpRunCreated.runId)
      } finally {
        waiter.close()
      }
    },
    {
      createModelRuntime: () => ({
        async *streamReply() {
          if (requestCount === 0) {
            requestCount += 1
            yield 'First reply'
            return
          }

          if (requestCount === 1) {
            requestCount += 1
            yield 'Retry'
            await new Promise<void>((resolve) => {
              releaseRetryRun = resolve
            })
            yield ' reply'
            return
          }

          yield 'Queued reply'
        }
      })
    }
  )
})
