import assert from 'node:assert/strict'
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { YachiyoServer } from './YachiyoServer.ts'
import { RETRY_MAX_ATTEMPTS } from '../runtime/modelRuntime.ts'
import type { ModelStreamRequest } from '../runtime/types.ts'
import type { SoulDocument } from '../runtime/soul.ts'
import { readUserDocument, writeUserDocument } from '../runtime/user.ts'
import { createInMemoryYachiyoStorage } from '../storage/memoryStorage.ts'
import type { MemoryService } from '../services/memory/memoryService.ts'
import type {
  ChatAccepted,
  ChatAcceptedWithUserMessage,
  UserDocument,
  YachiyoServerEvent
} from '../../../shared/yachiyo/protocol.ts'
import { withThreadCapabilities } from '../../../shared/yachiyo/protocol.ts'

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
    memoryService: options.memoryService
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

test('YachiyoServer streams a reply and persists the completed thread state', async () => {
  await withServer(async ({ server, completeRun, modelRequests }) => {
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
      content: 'Plan the MVP'
    })

    await completeRun(accepted.runId)

    const bootstrap = await server.bootstrap()
    const messages = bootstrap.messagesByThread[thread.id] ?? []

    assert.equal(messages.length, 2)
    assert.equal(messages[0]?.role, 'user')
    assert.equal(messages[0]?.content, 'Plan the MVP')
    assert.equal(messages[1]?.role, 'assistant')
    assert.equal(messages[1]?.content, 'Hello world')
    assert.equal(messages[1]?.modelId, 'gpt-5')
    assert.equal(messages[1]?.providerName, 'work')
    assert.equal(bootstrap.threads[0]?.title, 'Plan the MVP')
    assert.equal(bootstrap.threads[0]?.preview, 'Hello world')
    assert.equal(modelRequests.length, 1)
  })
})

test('YachiyoServer can refine the fallback thread title with the configured tool model', async () => {
  const requests: ModelStreamRequest[] = []
  let releaseMainRun: (() => void) | null = null
  const mainRunGate = new Promise<void>((resolve) => {
    releaseMainRun = resolve
  })

  await withServer(
    async ({ server, completeRun }) => {
      await server.upsertProvider({
        name: 'work',
        type: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        modelList: {
          enabled: ['gpt-5'],
          disabled: ['gpt-5-mini']
        }
      })

      await server.saveConfig({
        ...(await server.getConfig()),
        toolModel: {
          mode: 'custom',
          providerName: 'work',
          model: 'gpt-5-mini'
        }
      })

      const waiter = createServerEventWaiter(server)

      try {
        const thread = await server.createThread()
        const titleUpdatedEvent = waiter.waitForEvent(
          'thread.updated',
          (event) => event.threadId === thread.id && event.thread.title === 'MVP execution plan'
        )

        const accepted = await server.sendChat({
          threadId: thread.id,
          content: 'Plan the MVP'
        })

        const titleUpdate = await Promise.race([
          titleUpdatedEvent,
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Timed out waiting for title update')), 1000)
          })
        ])

        releaseMainRun?.()
        await completeRun(accepted.runId)
        const bootstrap = await server.bootstrap()
        const auxiliaryRequest = requests.find(
          (request) => request.providerOptionsMode === 'auxiliary'
        )
        const mainRequest = requests.find((request) => request.providerOptionsMode !== 'auxiliary')

        assert.equal(titleUpdate.thread.title, 'MVP execution plan')
        assert.equal(bootstrap.threads[0]?.title, 'MVP execution plan')
        assert.equal(requests.length, 2)
        assert.equal(mainRequest?.settings.model, 'gpt-5')
        assert.equal(mainRequest?.max_token, undefined)
        assert.equal(auxiliaryRequest?.settings.model, 'gpt-5-mini')
        assert.equal(auxiliaryRequest?.providerOptionsMode, 'auxiliary')
        assert.equal(auxiliaryRequest?.max_token, 128)
        assert.equal(auxiliaryRequest?.messages.length, 1)
        assert.match(
          typeof auxiliaryRequest?.messages[0]?.content === 'string'
            ? auxiliaryRequest.messages[0].content
            : '',
          /User query:/u
        )
        assert.match(
          typeof auxiliaryRequest?.messages[0]?.content === 'string'
            ? auxiliaryRequest.messages[0].content
            : '',
          /same language as the query/u
        )
        assert.match(
          typeof auxiliaryRequest?.messages[0]?.content === 'string'
            ? auxiliaryRequest.messages[0].content
            : '',
          /Do not repeat the user query verbatim\./u
        )
        assert.match(
          typeof auxiliaryRequest?.messages[0]?.content === 'string'
            ? auxiliaryRequest.messages[0].content
            : '',
          /Examples:/u
        )
        assert.doesNotMatch(
          typeof auxiliaryRequest?.messages[0]?.content === 'string'
            ? auxiliaryRequest.messages[0].content
            : '',
          /Conversation:/u
        )
      } finally {
        waiter.close()
      }
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (request.providerOptionsMode === 'auxiliary') {
            yield 'MVP execution plan'
            return
          }

          await mainRunGate
          yield 'Hello'
          yield ' world'
        }
      })
    }
  )
})

test('YachiyoServer applies configured chat max token to local thread runs', async () => {
  await withServer(async ({ server, completeRun, modelRequests }) => {
    await server.saveConfig({
      ...(await server.getConfig()),
      chat: {
        activeRunEnterBehavior: 'enter-steers',
        maxChatToken: 512
      }
    })

    const thread = await server.createThread()
    const accepted = await server.sendChat({
      threadId: thread.id,
      content: 'Keep it short.'
    })

    await completeRun(accepted.runId)

    const mainRequest = modelRequests.find((request) => request.providerOptionsMode !== 'auxiliary')
    assert.equal(mainRequest?.max_token, 512)
  })
})

test('YachiyoServer applies configured chat max token to external DM thread runs', async () => {
  await withServer(async ({ server, completeRun, modelRequests }) => {
    await server.saveConfig({
      ...(await server.getConfig()),
      chat: {
        activeRunEnterBehavior: 'enter-steers',
        maxChatToken: 640
      }
    })

    const thread = await server.createThread({
      source: 'telegram',
      channelUserId: 'tg-user-1'
    })
    const accepted = await server.sendChat({
      threadId: thread.id,
      content: 'Reply in DM.'
    })

    await completeRun(accepted.runId)

    const mainRequest = modelRequests.find((request) => request.providerOptionsMode !== 'auxiliary')
    assert.equal(mainRequest?.max_token, 640)
  })
})

test('YachiyoServer injects recalled memory into the compiled context before the main run', async () => {
  const recalledQueries: string[] = []

  await withServer(
    async ({ completeRun, modelRequests, server, waitForEvent }) => {
      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'How do we handle deploys?'
      })
      assertAcceptedHasUserMessage(accepted)
      const recalledEvent = (await waitForEvent('run.memory.recalled')) as {
        recalledMemoryEntries: string[]
        requestMessageId: string
        runId: string
      }
      await completeRun(accepted.runId)

      const mainRequest = modelRequests.find(
        (request) => request.providerOptionsMode !== 'auxiliary'
      )
      assert.ok(mainRequest)
      assert.equal(recalledQueries[0], 'How do we handle deploys?')
      assert.equal(recalledEvent.runId, accepted.runId)
      assert.equal(recalledEvent.requestMessageId, accepted.userMessage.id)
      assert.deepEqual(recalledEvent.recalledMemoryEntries, [
        'Deploy workflow: Always run the staging smoke test first.'
      ])
      assert.ok(
        mainRequest.messages.some(
          (message) =>
            message.role === 'user' &&
            typeof message.content === 'string' &&
            message.content.includes(
              '<memory>\n- Deploy workflow: Always run the staging smoke test first.\n</memory>'
            )
        )
      )
    },
    {
      memoryService: {
        hasHiddenSearchCapability: () => true,
        isConfigured: () => true,
        searchMemories: async () => [],
        testConnection: async () => ({ ok: true, message: 'Nowledge Mem is reachable.' }),
        recallForContext: async ({ thread, userQuery }) => {
          recalledQueries.push(userQuery)
          return {
            decision: {
              shouldRecall: true,
              score: 1,
              reasons: ['thread-cold-start'],
              messagesSinceLastRecall: 1,
              charsSinceLastRecall: userQuery.length,
              idleMs: 0,
              noveltyScore: 0.8,
              novelTerms: ['deploy']
            },
            entries: ['Deploy workflow: Always run the staging smoke test first.'],
            thread
          }
        },
        createMemory: async () => ({ savedCount: 0 }),
        validateAndCreateMemory: async () => ({ savedCount: 0 }),
        distillCompletedRun: async () => ({ savedCount: 0 }),
        saveThread: async () => ({ savedCount: 0 })
      }
    }
  )
})

test('YachiyoServer keeps the compile pipeline working when recall is gated off', async () => {
  await withServer(
    async ({ completeRun, modelRequests, server, waitForEvent }) => {
      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: '继续当前这个小问题'
      })
      assertAcceptedHasUserMessage(accepted)
      const recalledEvent = (await waitForEvent('run.memory.recalled')) as {
        recalledMemoryEntries: string[]
        recallDecision?: { shouldRecall: boolean; reasons: string[] }
      }
      await completeRun(accepted.runId)

      const mainRequest = modelRequests.find(
        (request) => request.providerOptionsMode !== 'auxiliary'
      )
      assert.ok(mainRequest)
      assert.deepEqual(recalledEvent.recalledMemoryEntries, [])
      assert.equal(recalledEvent.recallDecision?.shouldRecall, false)
      assert.deepEqual(recalledEvent.recallDecision?.reasons, [])
      assert.equal(
        mainRequest.messages.some(
          (message) =>
            message.role === 'system' &&
            typeof message.content === 'string' &&
            message.content.includes('<memory>')
        ),
        false
      )
    },
    {
      memoryService: {
        hasHiddenSearchCapability: () => true,
        isConfigured: () => true,
        searchMemories: async () => [],
        testConnection: async () => ({ ok: true, message: 'Nowledge Mem is reachable.' }),
        recallForContext: async ({ thread }) => ({
          decision: {
            shouldRecall: false,
            score: 0,
            reasons: [],
            messagesSinceLastRecall: 1,
            charsSinceLastRecall: 10,
            idleMs: 0,
            noveltyScore: 0,
            novelTerms: []
          },
          entries: [],
          thread
        }),
        createMemory: async () => ({ savedCount: 0 }),
        validateAndCreateMemory: async () => ({ savedCount: 0 }),
        distillCompletedRun: async () => ({ savedCount: 0 }),
        saveThread: async () => ({ savedCount: 0 })
      }
    }
  )
})

test('YachiyoServer bases recall history on the active branch during retry', async () => {
  const recalledHistoryIds: string[][] = []

  await withServer(
    async ({ completeRun, server }) => {
      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Need deploy guidance'
      })
      assertAcceptedHasUserMessage(accepted)
      await completeRun(accepted.runId)

      const retry = await server.retryMessage({
        threadId: thread.id,
        messageId: accepted.userMessage.id
      })
      await completeRun(retry.runId)

      assert.deepEqual(recalledHistoryIds[0], [accepted.userMessage.id])
      assert.deepEqual(
        recalledHistoryIds[1],
        [accepted.userMessage.id],
        'retry recall should not include the sibling assistant branch'
      )
    },
    {
      memoryService: {
        hasHiddenSearchCapability: () => true,
        isConfigured: () => true,
        searchMemories: async () => [],
        testConnection: async () => ({ ok: true, message: 'Nowledge Mem is reachable.' }),
        recallForContext: async ({ history, thread }) => {
          recalledHistoryIds.push(history.map((message) => message.id))
          return {
            decision: {
              shouldRecall: true,
              score: 1,
              reasons: ['thread-cold-start'],
              messagesSinceLastRecall: history.length,
              charsSinceLastRecall: history.reduce(
                (total, message) => total + message.content.length,
                0
              ),
              idleMs: 0,
              noveltyScore: 0.8,
              novelTerms: ['deploy']
            },
            entries: [],
            thread
          }
        },
        createMemory: async () => ({ savedCount: 0 }),
        validateAndCreateMemory: async () => ({ savedCount: 0 }),
        distillCompletedRun: async () => ({ savedCount: 0 }),
        saveThread: async () => ({ savedCount: 0 })
      }
    }
  )
})

test('YachiyoServer only injects the hidden memory_search runtime tool when memory is configured', async () => {
  const configuredRequests: ModelStreamRequest[] = []
  const disabledRequests: ModelStreamRequest[] = []

  await withServer(
    async ({ completeRun, server }) => {
      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Find the saved deploy workflow.'
      })
      assertAcceptedHasUserMessage(accepted)
      await completeRun(accepted.runId)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          configuredRequests.push(request)
          yield 'done'
        }
      }),
      memoryService: {
        hasHiddenSearchCapability: () => true,
        isConfigured: () => true,
        searchMemories: async () => [],
        testConnection: async () => ({ ok: true, message: 'Nowledge Mem is reachable.' }),
        recallForContext: async ({ thread }) => ({
          decision: {
            shouldRecall: false,
            score: 0,
            reasons: [],
            messagesSinceLastRecall: 0,
            charsSinceLastRecall: 0,
            idleMs: 0,
            noveltyScore: 0,
            novelTerms: []
          },
          entries: [],
          thread
        }),
        createMemory: async () => ({ savedCount: 0 }),
        validateAndCreateMemory: async () => ({ savedCount: 0 }),
        distillCompletedRun: async () => ({ savedCount: 0 }),
        saveThread: async () => ({ savedCount: 0 })
      }
    }
  )

  await withServer(
    async ({ completeRun, server }) => {
      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Find the saved deploy workflow.'
      })
      assertAcceptedHasUserMessage(accepted)
      await completeRun(accepted.runId)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          disabledRequests.push(request)
          yield 'done'
        }
      }),
      memoryService: {
        hasHiddenSearchCapability: () => false,
        isConfigured: () => false,
        searchMemories: async () => [],
        testConnection: async () => ({ ok: false, message: 'Memory disabled.' }),
        recallForContext: async ({ thread }) => ({
          decision: {
            shouldRecall: false,
            score: 0,
            reasons: [],
            messagesSinceLastRecall: 0,
            charsSinceLastRecall: 0,
            idleMs: 0,
            noveltyScore: 0,
            novelTerms: []
          },
          entries: [],
          thread
        }),
        createMemory: async () => ({ savedCount: 0 }),
        validateAndCreateMemory: async () => ({ savedCount: 0 }),
        distillCompletedRun: async () => ({ savedCount: 0 }),
        saveThread: async () => ({ savedCount: 0 })
      }
    }
  )

  const configuredMainRequest = configuredRequests.find(
    (request) => request.providerOptionsMode !== 'auxiliary'
  )
  const disabledMainRequest = disabledRequests.find(
    (request) => request.providerOptionsMode !== 'auxiliary'
  )

  assert.ok(configuredMainRequest?.tools)
  assert.equal('search_memory' in (configuredMainRequest?.tools ?? {}), true)
  assert.equal('search_memory' in (disabledMainRequest?.tools ?? {}), false)
})

test('YachiyoServer does not claim there are no tools when hidden memory search is the only tool', async () => {
  const modelRequests: ModelStreamRequest[] = []

  await withServer(
    async ({ completeRun, server }) => {
      await server.saveConfig({
        ...(await server.getConfig()),
        enabledTools: []
      })

      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Find the saved deploy workflow.'
      })
      assertAcceptedHasUserMessage(accepted)
      await completeRun(accepted.runId)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          modelRequests.push(request)
          yield 'done'
        }
      }),
      memoryService: {
        hasHiddenSearchCapability: () => true,
        isConfigured: () => true,
        searchMemories: async () => [],
        testConnection: async () => ({ ok: true, message: 'Nowledge Mem is reachable.' }),
        recallForContext: async ({ thread }) => ({
          decision: {
            shouldRecall: false,
            score: 0,
            reasons: [],
            messagesSinceLastRecall: 0,
            charsSinceLastRecall: 0,
            idleMs: 0,
            noveltyScore: 0,
            novelTerms: []
          },
          entries: [],
          thread
        }),
        createMemory: async () => ({ savedCount: 0 }),
        validateAndCreateMemory: async () => ({ savedCount: 0 }),
        distillCompletedRun: async () => ({ savedCount: 0 }),
        saveThread: async () => ({ savedCount: 0 })
      }
    }
  )

  const mainRequest = modelRequests.find((request) => request.providerOptionsMode !== 'auxiliary')
  const systemMessages = (mainRequest?.messages ?? []).filter(
    (message): message is { role: 'system'; content: string } =>
      message.role === 'system' && typeof message.content === 'string'
  )

  assert.ok(mainRequest?.tools)
  assert.equal('search_memory' in (mainRequest?.tools ?? {}), true)
  assert.equal(
    systemMessages.some((message) => /No tools are available for this run/u.test(message.content)),
    false
  )
  assert.equal(
    systemMessages.some((message) =>
      /Long-term memory search is available internally/u.test(message.content)
    ),
    true
  )
})

test('YachiyoServer continues the run when memory recall fails', async () => {
  await withServer(
    async ({ completeRun, modelRequests, server }) => {
      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Keep going even if memory is down.'
      })
      assertAcceptedHasUserMessage(accepted)
      await completeRun(accepted.runId)

      const mainRequest = modelRequests.find(
        (request) => request.providerOptionsMode !== 'auxiliary'
      )
      assert.ok(mainRequest)
      assert.ok(
        !mainRequest.messages.some(
          (message) =>
            message.role === 'system' &&
            typeof message.content === 'string' &&
            message.content.includes('<memory>')
        )
      )
    },
    {
      memoryService: {
        hasHiddenSearchCapability: () => true,
        isConfigured: () => true,
        searchMemories: async () => [],
        testConnection: async () => ({ ok: false, message: 'Cannot connect to Nowledge Mem' }),
        recallForContext: async () => {
          throw new Error('Cannot connect to Nowledge Mem')
        },
        createMemory: async () => ({ savedCount: 0 }),
        validateAndCreateMemory: async () => ({ savedCount: 0 }),
        distillCompletedRun: async () => ({ savedCount: 0 }),
        saveThread: async () => ({ savedCount: 0 })
      }
    }
  )
})

test('YachiyoServer saveThread uses the explicit memory service and can archive afterward', async () => {
  let savedThreadId = ''

  await withServer(
    async ({ completeRun, server }) => {
      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Remember the code review policy.'
      })
      assertAcceptedHasUserMessage(accepted)
      await completeRun(accepted.runId)

      const result = await server.saveThread({
        threadId: thread.id,
        archiveAfterSave: true
      })

      assert.equal(savedThreadId, thread.id)
      assert.equal(result.archived, true)
      assert.equal(result.savedMemoryCount, 2)

      const bootstrap = await server.bootstrap()
      assert.equal(bootstrap.threads.length, 0)
      assert.equal(bootstrap.archivedThreads[0]?.id, thread.id)
    },
    {
      memoryService: {
        hasHiddenSearchCapability: () => true,
        isConfigured: () => true,
        searchMemories: async () => [],
        testConnection: async () => ({ ok: true, message: 'Nowledge Mem is reachable.' }),
        recallForContext: async ({ thread }) => ({
          decision: {
            shouldRecall: false,
            score: 0,
            reasons: [],
            messagesSinceLastRecall: 0,
            charsSinceLastRecall: 0,
            idleMs: 0,
            noveltyScore: 0,
            novelTerms: []
          },
          entries: [],
          thread
        }),
        createMemory: async () => ({ savedCount: 0 }),
        validateAndCreateMemory: async () => ({ savedCount: 0 }),
        distillCompletedRun: async () => ({ savedCount: 0 }),
        saveThread: async ({ thread }) => {
          savedThreadId = thread.id
          return { savedCount: 2 }
        }
      }
    }
  )
})

test('YachiyoServer saveThread clears saving state when memory service throws', async () => {
  let callCount = 0

  await withServer(
    async ({ completeRun, server }) => {
      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Hello.'
      })
      assertAcceptedHasUserMessage(accepted)
      await completeRun(accepted.runId)

      // First save should throw
      await assert.rejects(() => server.saveThread({ threadId: thread.id }), /memory error/)

      // Second save should succeed — confirms saving state was cleared in the finally block
      const result = await server.saveThread({ threadId: thread.id })
      assert.equal(callCount, 2)
      assert.equal(result.archived, false)
    },
    {
      memoryService: {
        hasHiddenSearchCapability: () => true,
        isConfigured: () => true,
        searchMemories: async () => [],
        testConnection: async () => ({ ok: true, message: 'ok' }),
        recallForContext: async ({ thread }) => ({
          decision: {
            shouldRecall: false,
            score: 0,
            reasons: [],
            messagesSinceLastRecall: 0,
            charsSinceLastRecall: 0,
            idleMs: 0,
            noveltyScore: 0,
            novelTerms: []
          },
          entries: [],
          thread
        }),
        createMemory: async () => ({ savedCount: 0 }),
        validateAndCreateMemory: async () => ({ savedCount: 0 }),
        distillCompletedRun: async () => ({ savedCount: 0 }),
        saveThread: async () => {
          callCount++
          if (callCount === 1) throw new Error('memory error')
          return { savedCount: 1 }
        }
      }
    }
  )
})

test('YachiyoServer recoverInterruptedSaves reports interrupted save recovery on bootstrap', async () => {
  await withServer(
    async ({ server }) => {
      const thread = await server.createThread()
      ;(
        server as unknown as {
          storage: {
            beginThreadSave: (input: { threadId: string; savingStartedAt: string }) => void
          }
        }
      ).storage.beginThreadSave({
        threadId: thread.id,
        savingStartedAt: new Date().toISOString()
      })

      const bootstrap = await server.bootstrap()
      const found = bootstrap.threads.find((t) => t.id === thread.id)
      assert.ok(found, 'thread should be present and accessible after recovery')
      assert.deepEqual(bootstrap.recoveredInterruptedSaveThreadIds, [thread.id])
    },
    {
      memoryService: {
        hasHiddenSearchCapability: () => false,
        isConfigured: () => false,
        searchMemories: async () => [],
        testConnection: async () => ({ ok: false, message: '' }),
        recallForContext: async ({ thread }) => ({
          decision: {
            shouldRecall: false,
            score: 0,
            reasons: [],
            messagesSinceLastRecall: 0,
            charsSinceLastRecall: 0,
            idleMs: 0,
            noveltyScore: 0,
            novelTerms: []
          },
          entries: [],
          thread
        }),
        createMemory: async () => ({ savedCount: 0 }),
        validateAndCreateMemory: async () => ({ savedCount: 0 }),
        distillCompletedRun: async () => ({ savedCount: 0 }),
        saveThread: async () => ({ savedCount: 0 })
      }
    }
  )
})

test('YachiyoServer setThreadPrivacyMode updates the thread timestamp and persists the flag', async () => {
  let tick = 0

  await withServer(
    async ({ server }) => {
      const thread = await server.createThread()
      const bootstrap = await server.bootstrap()
      const originalThread = bootstrap.threads.find((entry) => entry.id === thread.id)

      assert.ok(originalThread)

      const privateThread = await server.setThreadPrivacyMode({
        threadId: thread.id,
        enabled: true
      })

      assert.equal(privateThread.privacyMode, true)
      assert.notEqual(privateThread.updatedAt, originalThread.updatedAt)

      let reloaded = await server.bootstrap()
      const reloadedPrivateThread = reloaded.threads.find((entry) => entry.id === thread.id)

      assert.equal(reloadedPrivateThread?.privacyMode, true)
      assert.equal(reloadedPrivateThread?.updatedAt, privateThread.updatedAt)

      const publicThread = await server.setThreadPrivacyMode({
        threadId: thread.id,
        enabled: false
      })

      assert.equal(publicThread.privacyMode, undefined)
      assert.ok(publicThread.updatedAt > privateThread.updatedAt)

      reloaded = await server.bootstrap()
      const reloadedPublicThread = reloaded.threads.find((entry) => entry.id === thread.id)

      assert.equal(reloadedPublicThread?.privacyMode, undefined)
      assert.equal(reloadedPublicThread?.updatedAt, publicThread.updatedAt)
    },
    {
      now: () => new Date(Date.UTC(2026, 2, 15, 0, 0, tick++))
    }
  )
})

test('YachiyoServer createThread persists privacy mode when requested', async () => {
  await withServer(async ({ server }) => {
    const thread = await server.createThread({ privacyMode: true })

    assert.equal(thread.privacyMode, true)

    const bootstrap = await server.bootstrap()
    const storedThread = bootstrap.threads.find((entry) => entry.id === thread.id)

    assert.equal(storedThread?.privacyMode, true)
  })
})

test('YachiyoServer rejects ACP rebinding once a thread already has history', async () => {
  await withServer(async ({ server, completeRun }) => {
    await server.upsertProvider({
      name: 'work',
      type: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      modelList: { enabled: ['gpt-5'], disabled: [] }
    })

    const thread = await server.createThread()
    const accepted = await server.sendChat({ threadId: thread.id, content: 'Keep this context' })
    assertAcceptedHasUserMessage(accepted)
    await completeRun(accepted.runId)

    await assert.rejects(
      () =>
        server.setThreadRuntimeBinding({
          threadId: thread.id,
          runtimeBinding: {
            kind: 'acp',
            profileId: 'agent-1',
            profileName: 'ACP Agent',
            sessionStatus: 'new'
          }
        }),
      /ACP agents can only be attached before messages have been sent/
    )
  })
})

test('YachiyoServer exposes thread capabilities and blocks ACP-only leaked run semantics', async () => {
  await withServer(async ({ server, storage }) => {
    const createdAt = '2026-03-15T00:00:00.000Z'

    storage.createThread({
      thread: withThreadCapabilities({
        id: 'thread-acp',
        title: 'ACP thread',
        updatedAt: createdAt,
        headMessageId: 'assistant-1',
        runtimeBinding: {
          kind: 'acp',
          profileId: 'agent-1',
          profileName: 'ACP Agent',
          sessionStatus: 'active'
        }
      }),
      createdAt,
      messages: [
        {
          id: 'user-1',
          threadId: 'thread-acp',
          role: 'user',
          content: 'hello',
          status: 'completed',
          createdAt
        },
        {
          id: 'assistant-1',
          threadId: 'thread-acp',
          parentMessageId: 'user-1',
          role: 'assistant',
          content: 'hi',
          status: 'completed',
          createdAt: '2026-03-15T00:00:01.000Z'
        }
      ]
    })

    const bootstrap = await server.bootstrap()
    const thread = bootstrap.threads.find((entry) => entry.id === 'thread-acp')

    assert.deepEqual(thread?.capabilities, {
      canRetry: false,
      canCreateBranch: false,
      canSelectReplyBranch: false,
      canEdit: false,
      canDelete: false
    })

    await assert.rejects(
      server.retryMessage({
        threadId: 'thread-acp',
        messageId: 'assistant-1'
      }),
      /ACP threads do not support retry/
    )

    await assert.rejects(
      server.createBranch({
        threadId: 'thread-acp',
        messageId: 'assistant-1'
      }),
      /ACP threads do not support branching/
    )

    await assert.rejects(
      server.selectReplyBranch({
        threadId: 'thread-acp',
        assistantMessageId: 'assistant-1'
      }),
      /ACP threads do not support reply branch navigation/
    )

    await assert.rejects(
      server.editMessage({
        threadId: 'thread-acp',
        messageId: 'user-1',
        content: 'edited'
      }),
      /ACP threads do not support editing messages/
    )

    await assert.rejects(
      server.deleteMessageFromHere({
        threadId: 'thread-acp',
        messageId: 'assistant-1'
      }),
      /ACP threads do not support deleting messages/
    )
  })
})

test('YachiyoServer restores interactive capabilities after removing an ACP binding', async () => {
  await withServer(async ({ server }) => {
    const thread = await server.createThread()

    const acpThread = await server.setThreadRuntimeBinding({
      threadId: thread.id,
      runtimeBinding: {
        kind: 'acp',
        profileId: 'agent-1',
        profileName: 'ACP Agent',
        sessionStatus: 'new'
      }
    })
    assert.equal(acpThread.capabilities?.canRetry, false)
    assert.equal(acpThread.capabilities?.canEdit, false)

    const llmThread = await server.setThreadRuntimeBinding({
      threadId: thread.id,
      runtimeBinding: null
    })
    assert.deepEqual(llmThread.capabilities, {
      canRetry: true,
      canCreateBranch: true,
      canSelectReplyBranch: true,
      canEdit: true,
      canDelete: true
    })
  })
})

test('YachiyoServer starThread preserves thread recency while persisting star state', async () => {
  let tick = 0

  await withServer(
    async ({ server }) => {
      const thread = await server.createThread()
      const bootstrap = await server.bootstrap()
      const originalThread = bootstrap.threads.find((entry) => entry.id === thread.id)

      assert.ok(originalThread)

      const starredThread = await server.starThread({
        threadId: thread.id,
        starred: true
      })

      assert.ok(starredThread.starredAt)
      assert.equal(starredThread.updatedAt, originalThread.updatedAt)

      let reloaded = await server.bootstrap()
      const reloadedStarredThread = reloaded.threads.find((entry) => entry.id === thread.id)

      assert.equal(reloadedStarredThread?.starredAt, starredThread.starredAt)
      assert.equal(reloadedStarredThread?.updatedAt, originalThread.updatedAt)

      const unstarredThread = await server.starThread({
        threadId: thread.id,
        starred: false
      })

      assert.equal(unstarredThread.starredAt, undefined)
      assert.equal(unstarredThread.updatedAt, originalThread.updatedAt)

      reloaded = await server.bootstrap()
      const reloadedUnstarredThread = reloaded.threads.find((entry) => entry.id === thread.id)

      assert.equal(reloadedUnstarredThread?.starredAt, undefined)
      assert.equal(reloadedUnstarredThread?.updatedAt, originalThread.updatedAt)
    },
    {
      now: () => new Date(Date.UTC(2026, 2, 15, 0, 0, tick++))
    }
  )
})

test('YachiyoServer tests memory connectivity against the provided draft config', async () => {
  let receivedConfig: unknown = null

  await withServer(
    async ({ server }) => {
      const result = await server.testMemoryConnection({
        providers: [],
        memory: {
          enabled: true,
          provider: 'nowledge-mem',
          baseUrl: 'http://127.0.0.1:14242'
        }
      })

      assert.deepEqual(receivedConfig, {
        providers: [],
        memory: {
          enabled: true,
          provider: 'nowledge-mem',
          baseUrl: 'http://127.0.0.1:14242'
        }
      })
      assert.deepEqual(result, {
        ok: true,
        message: 'Nowledge Mem is reachable.'
      })
    },
    {
      memoryService: {
        hasHiddenSearchCapability: () => true,
        isConfigured: () => true,
        searchMemories: async () => [],
        testConnection: async (config) => {
          receivedConfig = config
          return { ok: true, message: 'Nowledge Mem is reachable.' }
        },
        recallForContext: async ({ thread }) => ({
          decision: {
            shouldRecall: false,
            score: 0,
            reasons: [],
            messagesSinceLastRecall: 0,
            charsSinceLastRecall: 0,
            idleMs: 0,
            noveltyScore: 0,
            novelTerms: []
          },
          entries: [],
          thread
        }),
        createMemory: async () => ({ savedCount: 0 }),
        validateAndCreateMemory: async () => ({ savedCount: 0 }),
        distillCompletedRun: async () => ({ savedCount: 0 }),
        saveThread: async () => ({ savedCount: 0 })
      }
    }
  )
})

test('YachiyoServer keeps the simple fallback title when tool-model title generation fails', async () => {
  const requests: ModelStreamRequest[] = []

  await withServer(
    async ({ server, completeRun }) => {
      await server.upsertProvider({
        name: 'work',
        type: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        modelList: {
          enabled: ['gpt-5'],
          disabled: ['gpt-5-mini']
        }
      })

      await server.saveConfig({
        ...(await server.getConfig()),
        toolModel: {
          mode: 'custom',
          providerName: 'work',
          model: 'gpt-5-mini'
        }
      })

      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Plan the MVP'
      })

      await completeRun(accepted.runId)
      await new Promise((resolve) => setTimeout(resolve, 0))

      const bootstrap = await server.bootstrap()
      const auxiliaryRequest = requests.find(
        (request) => request.providerOptionsMode === 'auxiliary'
      )
      assert.equal(bootstrap.threads[0]?.title, 'Plan the MVP')
      assert.equal(requests.length, 2)
      assert.equal(auxiliaryRequest?.settings.model, 'gpt-5-mini')
      assert.equal(auxiliaryRequest?.providerOptionsMode, 'auxiliary')
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (request.providerOptionsMode === 'auxiliary') {
            throw new Error('Tool model unavailable')
          }

          yield 'Hello'
          yield ' world'
        }
      })
    }
  )
})

test('YachiyoServer snapshots the enabled tool subset and sends tool-change reminders as a hint layer', async () => {
  await withServer(async ({ server, completeRun, modelRequests }) => {
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

    const firstRun = await server.sendChat({
      threadId: thread.id,
      content: 'Default tool run',
      enabledTools: ['read', 'write', 'edit', 'bash', 'webRead']
    })
    await completeRun(firstRun.runId)

    const secondRun = await server.sendChat({
      threadId: thread.id,
      content: 'Use only read and bash',
      enabledTools: ['read', 'bash']
    })
    await completeRun(secondRun.runId)

    const thirdRun = await server.sendChat({
      threadId: thread.id,
      content: 'Turn write back on',
      enabledTools: ['read', 'write', 'bash']
    })
    await completeRun(thirdRun.runId)

    // All user-managed tools are always registered for cache stability.
    // grep/glob are present (server creates a default searchService).
    // webSearch is absent (no webSearchService provided).
    assert.deepEqual(Object.keys(modelRequests[0]?.tools ?? {}), [
      'read',
      'write',
      'edit',
      'bash',
      'webRead',
      'grep',
      'glob',
      'webSearch',
      'update_profile',
      'askUser'
    ])
    assert.ok(String(modelRequests[0]?.messages.at(-1)?.content).startsWith('Default tool run'))

    // Second run only enables read+bash, but all non-service-gated tools stay registered.
    assert.deepEqual(Object.keys(modelRequests[1]?.tools ?? {}), [
      'read',
      'write',
      'edit',
      'bash',
      'webRead',
      'grep',
      'glob',
      'webSearch',
      'update_profile',
      'askUser'
    ])
    assert.ok(
      String(modelRequests[1]?.messages.at(-1)?.content).startsWith('Use only read and bash')
    )
    assert.ok(
      modelRequests[1]?.messages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('Disabled tools:') &&
          message.content.includes('write') &&
          message.content.includes('edit') &&
          message.content.includes('webRead')
      )
    )

    assert.deepEqual(Object.keys(modelRequests[2]?.tools ?? {}), [
      'read',
      'write',
      'edit',
      'bash',
      'webRead',
      'grep',
      'glob',
      'webSearch',
      'update_profile',
      'askUser'
    ])
    assert.ok(String(modelRequests[2]?.messages.at(-1)?.content).startsWith('Turn write back on'))
    assert.ok(
      modelRequests[2]?.messages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('Disabled tools:') &&
          message.content.includes('edit') &&
          message.content.includes('webRead')
      )
    )

    const bootstrap = await server.bootstrap()
    const messages = bootstrap.messagesByThread[thread.id] ?? []
    assert.equal(messages[2]?.content, 'Use only read and bash')
    assert.equal(messages[4]?.content, 'Turn write back on')
  })
})

test('YachiyoServer injects only active skill summaries into runtime context and exposes skillsRead', async () => {
  await withServer(async ({ server, completeRun, modelRequests, workspacePathForThread }) => {
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
    const workspacePath = workspacePathForThread(thread.id)

    await mkdir(join(workspacePath, '.yachiyo', 'skills', 'workspace-refactor'), {
      recursive: true
    })
    await writeFile(
      join(workspacePath, '.yachiyo', 'skills', 'workspace-refactor', 'SKILL.md'),
      [
        '---',
        'name: workspace-refactor',
        'description: Workspace refactor guide',
        '---',
        '',
        '# Workspace Refactor',
        '',
        'Detailed implementation instructions.'
      ].join('\n')
    )

    await server.saveConfig({
      ...(await server.getConfig()),
      skills: {
        enabled: ['workspace-refactor']
      }
    })

    const accepted = await server.sendChat({
      threadId: thread.id,
      content: 'Use the local skill summary',
      enabledTools: ['read']
    })
    await completeRun(accepted.runId)

    const request = modelRequests.at(-1)
    assert.ok(request)
    assert.deepEqual(Object.keys(request.tools ?? {}), [
      'read',
      'write',
      'edit',
      'bash',
      'webRead',
      'grep',
      'glob',
      'webSearch',
      'skillsRead',
      'update_profile',
      'askUser'
    ])
    assert.ok(
      request.messages.some(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.includes('workspace-refactor: Workspace refactor guide')
      )
    )
    assert.ok(
      !request.messages.some(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.includes('Detailed implementation instructions.')
      )
    )
  })
})

test('YachiyoServer keeps @file mentions visible in chat while injecting hidden file context for the model', async () => {
  await withServer(async ({ server, completeRun, modelRequests, workspacePathForThread }) => {
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
    const workspacePath = workspacePathForThread(thread.id)
    await mkdir(join(workspacePath, 'src'), { recursive: true })
    await writeFile(
      join(workspacePath, 'src', 'tiny.ts'),
      ['export const tiny = true', 'export const answer = 42'].join('\n'),
      'utf8'
    )

    const accepted = await server.sendChat({
      threadId: thread.id,
      content: 'Check @src/tiny.ts before changing it.'
    })
    await completeRun(accepted.runId)

    const bootstrap = await server.bootstrap()
    assert.equal(
      bootstrap.messagesByThread[thread.id]?.[0]?.content,
      'Check @src/tiny.ts before changing it.'
    )

    const request = modelRequests.at(-1)
    assert.ok(request)
    const lastContent = String(request.messages.at(-1)?.content ?? '')
    assert.match(lastContent, /<file_mentions>/)
    assert.match(lastContent, /<referenced_file path="src\/tiny\.ts">/)
    assert.match(lastContent, /Check @src\/tiny\.ts before changing it\./)
  })
})

test('YachiyoServer keeps @folder mentions visible in chat while injecting a shallow hidden directory listing for the model', async () => {
  await withServer(async ({ server, completeRun, modelRequests, workspacePathForThread }) => {
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
    const workspacePath = workspacePathForThread(thread.id)
    await mkdir(join(workspacePath, 'src', 'components', 'nested'), { recursive: true })
    await writeFile(
      join(workspacePath, 'src', 'components', 'Composer.tsx'),
      'export function Composer() { return null }\n',
      'utf8'
    )
    await writeFile(
      join(workspacePath, 'src', 'components', '.secret.ts'),
      'export const secret = true\n',
      'utf8'
    )
    await writeFile(
      join(workspacePath, 'src', 'components', 'nested', 'deep.ts'),
      'export const deep = true\n',
      'utf8'
    )

    const accepted = await server.sendChat({
      threadId: thread.id,
      content: 'Check @!src/components before changing it.'
    })
    await completeRun(accepted.runId)

    const bootstrap = await server.bootstrap()
    assert.equal(
      bootstrap.messagesByThread[thread.id]?.[0]?.content,
      'Check @!src/components before changing it.'
    )

    const request = modelRequests.at(-1)
    assert.ok(request)
    assert.match(String(request.messages.at(-1)?.content ?? ''), /<file_mentions>/)
    assert.match(
      String(request.messages.at(-1)?.content ?? ''),
      /<referenced_directory path="src\/components">/
    )
    assert.match(String(request.messages.at(-1)?.content ?? ''), /Composer\.tsx/)
    assert.match(String(request.messages.at(-1)?.content ?? ''), /\.secret\.ts/)
    assert.match(String(request.messages.at(-1)?.content ?? ''), /nested\//)
    assert.doesNotMatch(String(request.messages.at(-1)?.content ?? ''), /deep\.ts/)
    assert.match(
      String(request.messages.at(-1)?.content ?? ''),
      /Check @!src\/components before changing it\./
    )
  })
})

test('YachiyoServer fails runs cleanly when thread workspace initialization fails', async () => {
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
      const firstRun = await server.sendChat({
        threadId: thread.id,
        content: 'This run should fail before the model starts.'
      })

      await assert.rejects(completeRun(firstRun.runId), /Workspace initialization failed/)

      const secondRun = await server.sendChat({
        threadId: thread.id,
        content: 'This thread should not stay wedged as running.'
      })

      await assert.rejects(completeRun(secondRun.runId), /Workspace initialization failed/)

      const bootstrap = await server.bootstrap()
      assert.equal(bootstrap.messagesByThread[thread.id]?.length, 4)
      assert.deepEqual(
        (bootstrap.messagesByThread[thread.id] ?? []).map((message) => message.status),
        ['completed', 'failed', 'completed', 'failed']
      )
    },
    {
      ensureThreadWorkspace: async () => {
        throw new Error('Workspace unavailable')
      }
    }
  )
})

test('YachiyoServer allows setting a specific workspace before the first send and locks it after', async () => {
  await withServer(
    async ({ completeRun, server }) => {
      const firstWorkspace = join(tmpdir(), 'yachiyo-specific-workspace-a')
      const secondWorkspace = join(tmpdir(), 'yachiyo-specific-workspace-b')

      const thread = await server.createThread({
        workspacePath: firstWorkspace
      })
      assert.equal(thread.workspacePath, firstWorkspace)

      const updatedThread = await server.updateThreadWorkspace({
        threadId: thread.id,
        workspacePath: secondWorkspace
      })
      assert.equal(updatedThread.workspacePath, secondWorkspace)

      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Hello'
      })
      await completeRun(accepted.runId)

      await assert.rejects(
        server.updateThreadWorkspace({
          threadId: thread.id,
          workspacePath: null
        }),
        /before the first message is sent/
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply(): AsyncIterable<string> {
          yield 'Done'
        }
      })
    }
  )
})

test('YachiyoServer surfaces ignored workspace matches for the picker as @! candidates', async () => {
  await withServer(async ({ server, workspacePathForThread }) => {
    const thread = await server.createThread()
    const workspacePath = workspacePathForThread(thread.id)

    await mkdir(join(workspacePath, 'docs'), { recursive: true })
    await writeFile(join(workspacePath, '.gitignore'), 'docs/\n', 'utf8')
    await writeFile(join(workspacePath, 'docs', 'ACP_CAPABILITY_GAP.md'), '# Gap\n', 'utf8')

    const results = await server.searchWorkspaceFiles({
      threadId: thread.id,
      query: 'docs/ACP'
    })

    assert.deepEqual(results, [{ path: 'docs/ACP_CAPABILITY_GAP.md', includeIgnored: true }])
  })
})

test('YachiyoServer does not surface exact ignored path matches for bare @file validation', async () => {
  await withServer(async ({ server, workspacePathForThread }) => {
    const thread = await server.createThread()
    const workspacePath = workspacePathForThread(thread.id)

    await mkdir(workspacePath, { recursive: true })
    await writeFile(join(workspacePath, '.gitignore'), 'secret.txt\n', 'utf8')
    await writeFile(join(workspacePath, 'secret.txt'), 'top secret\n', 'utf8')

    const results = await server.searchWorkspaceFiles({
      threadId: thread.id,
      query: 'secret.txt'
    })

    assert.deepEqual(results, [])
  })
})

test('YachiyoServer creates a per-thread workspace, persists structured tool details, and updates the same tool call through its lifecycle', async () => {
  let toolWorkspacePath = ''

  await withServer(
    async ({ server, completeRun, waitForEvent, workspacePathForThread }) => {
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
      toolWorkspacePath = workspacePathForThread(thread.id)

      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'List the workspace files.'
      })
      assertAcceptedHasUserMessage(accepted)

      const startedToolEvent = (await waitForEvent('tool.updated')) as {
        toolCall: {
          id: string
          status: string
          details?: unknown
          outputSummary?: string
        }
      }
      const updatedToolEvent = (await waitForEvent('tool.updated')) as {
        toolCall: {
          id: string
          status: string
          details?: {
            command?: string
            cwd?: string
            stderr?: string
            stdout?: string
          }
          outputSummary?: string
        }
      }
      const laterToolEvent = (await waitForEvent('tool.updated')) as {
        toolCall: {
          id: string
          status: string
          details?: {
            command?: string
            cwd?: string
            stderr?: string
            stdout?: string
          }
          outputSummary?: string
        }
      }
      const streamingToolEvent =
        updatedToolEvent.toolCall.outputSummary === 'streaming output'
          ? updatedToolEvent
          : laterToolEvent

      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const toolCalls = bootstrap.toolCallsByThread[thread.id] ?? []

      assert.equal(startedToolEvent.toolCall.status, 'running')
      assert.equal(startedToolEvent.toolCall.details, undefined)
      assert.equal(streamingToolEvent.toolCall.id, startedToolEvent.toolCall.id)
      assert.equal(streamingToolEvent.toolCall.status, 'running')
      assert.equal(streamingToolEvent.toolCall.details?.cwd, toolWorkspacePath)
      assert.equal(streamingToolEvent.toolCall.details?.stdout, `${toolWorkspacePath}\n`)
      assert.equal(streamingToolEvent.toolCall.outputSummary, 'streaming output')

      assert.equal(toolCalls.length, 1)
      assert.equal(toolCalls[0]?.toolName, 'bash')
      assert.equal(toolCalls[0]?.status, 'completed')
      assert.equal(toolCalls[0]?.cwd, toolWorkspacePath)
      assert.equal(toolCalls[0]?.inputSummary, 'pwd && ls')
      assert.equal(toolCalls[0]?.outputSummary, 'exit 0')
      assert.deepEqual(toolCalls[0]?.details, {
        command: 'pwd && ls',
        cwd: toolWorkspacePath,
        exitCode: 0,
        stderr: '',
        stdout: `${toolWorkspacePath}\n`
      })

      const requestMessageId = bootstrap.messagesByThread[thread.id]?.[0]?.id
      const assistantMessageId = bootstrap.messagesByThread[thread.id]?.[1]?.id
      assert.equal(typeof requestMessageId, 'string')
      assert.equal(toolCalls[0]?.requestMessageId, requestMessageId)
      assert.equal(toolCalls[0]?.assistantMessageId, assistantMessageId)

      const deleted = await server.deleteMessageFromHere({
        threadId: thread.id,
        messageId: requestMessageId as string
      })

      assert.deepEqual(deleted.toolCalls, [])
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          request.onToolCallStart?.({
            abortSignal: request.signal,
            experimental_context: undefined,
            functionId: undefined,
            messages: request.messages,
            metadata: undefined,
            model: undefined,
            stepNumber: 0,
            toolCall: {
              input: { command: 'pwd && ls' },
              toolCallId: 'tool-bash-1',
              toolName: 'bash'
            }
          } as never)

          request.onToolCallUpdate?.({
            output: {
              content: [{ type: 'text', text: `${toolWorkspacePath}\n` }],
              details: {
                command: 'pwd && ls',
                cwd: toolWorkspacePath,
                stderr: '',
                stdout: `${toolWorkspacePath}\n`
              },
              metadata: {
                cwd: toolWorkspacePath
              }
            },
            toolCall: {
              input: { command: 'pwd && ls' },
              toolCallId: 'tool-bash-1',
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
              content: [{ type: 'text', text: `${toolWorkspacePath}\n` }],
              details: {
                command: 'pwd && ls',
                cwd: toolWorkspacePath,
                exitCode: 0,
                stderr: '',
                stdout: `${toolWorkspacePath}\n`
              },
              metadata: {
                cwd: toolWorkspacePath,
                exitCode: 0
              }
            },
            toolCall: {
              input: { command: 'pwd && ls' },
              toolCallId: 'tool-bash-1',
              toolName: 'bash'
            }
          } as never)

          yield 'Done'
        }
      })
    }
  )
})

test('YachiyoServer accepts image-first user input and forwards it as multimodal content', async () => {
  await withServer(async ({ server, completeRun, modelRequests }) => {
    await server.upsertProvider({
      name: 'vision',
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
      content: '',
      images: [
        {
          dataUrl: 'data:image/png;base64,AAAA',
          mediaType: 'image/png',
          filename: 'whiteboard.png'
        }
      ]
    })

    await completeRun(accepted.runId)

    const bootstrap = await server.bootstrap()
    const messages = bootstrap.messagesByThread[thread.id] ?? []

    assert.equal(accepted.thread.title, 'Shared an image')
    const savedImage = messages[0]?.images?.[0]
    assert.equal(savedImage?.dataUrl, 'data:image/png;base64,AAAA')
    assert.equal(savedImage?.mediaType, 'image/png')
    assert.equal(savedImage?.filename, 'whiteboard.png')
    assert.ok(
      typeof savedImage?.workspacePath === 'string' &&
        savedImage.workspacePath.endsWith('whiteboard.png'),
      'image should be saved to workspace'
    )
    const lastModelMessage = modelRequests[0]?.messages.at(-1)
    assert.equal(lastModelMessage?.role, 'user')
    assert.ok(Array.isArray(lastModelMessage?.content), 'content should be an array')
    const contentArray = lastModelMessage?.content as {
      type: string
      image?: string
      mediaType?: string
      text?: string
    }[]
    const imagePart = contentArray.find((part) => part.type === 'image')
    assert.deepEqual(imagePart, { type: 'image', image: 'AAAA', mediaType: 'image/png' })
    const textPart = contentArray.find((part) => part.type === 'text')
    assert.ok(
      textPart?.text?.includes('<attached_files>'),
      'model message should include attached_files block'
    )
  })
})

test('YachiyoServer accepts active-run steer as an ordinary message and forwards steer images', async () => {
  const requests: ModelStreamRequest[] = []
  let attempt = 0

  await withServer(
    async ({ server, completeRun, waitForEvent }) => {
      await server.upsertProvider({
        name: 'vision',
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
        content: 'Start with the code path'
      })

      await waitForEvent('message.delta')

      const steerAccepted = await server.sendChat({
        threadId: thread.id,
        content: 'Use the screenshot instead',
        images: [
          {
            dataUrl: 'data:image/png;base64,BBBB',
            mediaType: 'image/png',
            filename: 'screenshot.png'
          }
        ],
        mode: 'steer'
      })

      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const messages = bootstrap.messagesByThread[thread.id] ?? []

      assert.equal(steerAccepted.kind, 'active-run-steer')
      assert.equal(steerAccepted.runId, accepted.runId)
      assert.equal(messages.length, 4)
      assert.equal(messages[0]?.content, 'Start with the code path')
      assert.equal(messages[1]?.content, 'Use the screenshot instead')
      const steerImage = messages[1]?.images?.[0]
      assert.equal(steerImage?.dataUrl, 'data:image/png;base64,BBBB')
      assert.equal(steerImage?.mediaType, 'image/png')
      assert.equal(steerImage?.filename, 'screenshot.png')
      assert.ok(
        typeof steerImage?.workspacePath === 'string' &&
          steerImage.workspacePath.endsWith('screenshot.png'),
        'steer image should be saved to workspace'
      )
      assert.equal(messages[2]?.role, 'assistant')
      assert.equal(messages[2]?.status, 'stopped')
      assert.equal(messages[3]?.role, 'assistant')
      assert.equal(messages[3]?.parentMessageId, steerAccepted.userMessage.id)
      const steerModelMsg = requests[1]?.messages.at(-1)
      assert.equal(steerModelMsg?.role, 'user')
      assert.ok(Array.isArray(steerModelMsg?.content))
      const steerContent = steerModelMsg?.content as {
        type: string
        text?: string
        image?: string
        mediaType?: string
      }[]
      const steerImagePart = steerContent.find((p) => p.type === 'image')
      assert.deepEqual(steerImagePart, { type: 'image', image: 'BBBB', mediaType: 'image/png' })
      const steerTextPart = steerContent.find((p) => p.type === 'text')
      assert.ok(steerTextPart?.text?.includes('Use the screenshot instead'))
      assert.ok(steerTextPart?.text?.includes('<attached_files>'))
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (attempt === 0) {
            attempt += 1
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

          yield 'Steered'
          yield ' reply'
        }
      })
    }
  )
})

test('steer during generation preserves partial assistant content as a stopped message', async () => {
  let attempt = 0

  await withServer(
    async ({ server, completeRun, waitForEvent }) => {
      await server.upsertProvider({
        name: 'default',
        type: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        modelList: { enabled: ['gpt-5'], disabled: [] }
      })

      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Tell me something long'
      })

      await waitForEvent('message.delta')

      const steerAccepted = await server.sendChat({
        threadId: thread.id,
        content: 'Never mind, do this instead',
        mode: 'steer'
      })

      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const messages = bootstrap.messagesByThread[thread.id] ?? []

      assert.equal(steerAccepted.kind, 'active-run-steer')

      const partialMsg = messages.find((m) => m.role === 'assistant' && m.status === 'stopped')
      assert.ok(partialMsg, 'partial assistant message should exist')
      assert.ok(partialMsg.content.length > 0, 'partial content should be non-empty')
      assert.equal(partialMsg.status, 'stopped')
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          if (attempt === 0) {
            attempt += 1
            yield 'Here is the partial answer'
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
          yield 'New answer'
        }
      })
    }
  )
})

test('steer before any output does not emit a retrying state', async () => {
  let attempt = 0
  const retryEvents: Array<{ attempt: number; error: string }> = []

  await withServer(
    async ({ server, completeRun, waitForEvent }) => {
      await server.upsertProvider({
        name: 'default',
        type: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        modelList: { enabled: ['gpt-5'], disabled: [] }
      })

      const unsubscribe = server.subscribe((event) => {
        if (event.type !== 'run.retrying') {
          return
        }

        retryEvents.push({
          attempt: event.attempt,
          error: event.error
        })
      })

      try {
        const thread = await server.createThread()
        const accepted = await server.sendChat({
          threadId: thread.id,
          content: 'Start the run'
        })

        await waitForEvent('message.started')

        const steerAccepted = await server.sendChat({
          threadId: thread.id,
          content: 'Do this instead',
          mode: 'steer'
        })

        await completeRun(accepted.runId)

        const bootstrap = await server.bootstrap()
        const messages = bootstrap.messagesByThread[thread.id] ?? []

        assert.equal(steerAccepted.kind, 'active-run-steer')
        assert.deepEqual(retryEvents, [])
        assert.equal(messages.length, 3)
        assert.equal(messages[0]?.content, 'Start the run')
        assert.equal(messages[1]?.content, 'Do this instead')
        assert.equal(messages[2]?.content, 'Steered reply')
      } finally {
        unsubscribe()
      }
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          if (attempt === 0) {
            attempt += 1
            await new Promise((_, reject) => {
              const abort = (): void => {
                reject(request.signal.reason ?? new Error('Aborted'))
              }

              if (request.signal.aborted) {
                abort()
                return
              }

              request.signal.addEventListener('abort', abort, { once: true })
            })
            return
          }

          yield 'Steered'
          yield ' reply'
        }
      })
    }
  )
})

test('YachiyoServer restarts on steer even when the runtime returns normally after abort was requested', async () => {
  const requests: ModelStreamRequest[] = []
  let attempt = 0
  let releaseFirstRun: (() => void) | null = null
  let markFirstRunReady: (() => void) | null = null
  const firstRunReady = new Promise<void>((resolve) => {
    markFirstRunReady = resolve
  })

  await withServer(
    async ({ server, completeRun, waitForEvent }) => {
      await server.upsertProvider({
        name: 'vision',
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
        content: 'Start with the code path'
      })

      await waitForEvent('message.started')
      await firstRunReady

      const steerAccepted = await server.sendChat({
        threadId: thread.id,
        content: 'Use the screenshot instead',
        mode: 'steer'
      })

      releaseFirstRun?.()
      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const messages = bootstrap.messagesByThread[thread.id] ?? []

      assert.equal(steerAccepted.kind, 'active-run-steer')
      assert.equal(steerAccepted.runId, accepted.runId)
      assert.equal(messages.length, 3)
      assert.equal(messages[0]?.content, 'Start with the code path')
      assert.equal(messages[1]?.content, 'Use the screenshot instead')
      assert.equal(messages[2]?.role, 'assistant')
      assert.equal(messages[2]?.content, 'Steered reply')
      assert.equal(messages[2]?.parentMessageId, steerAccepted.userMessage.id)
      for (const [i, expected] of [
        'Start with the code path',
        'Use the screenshot instead'
      ].entries()) {
        assert.ok(
          String(requests[i]?.messages.at(-1)?.content).startsWith(expected),
          `request ${i} last message should start with "${expected}"`
        )
      }
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (attempt === 0) {
            attempt += 1
            await new Promise<void>((resolve) => {
              releaseFirstRun = resolve
              markFirstRunReady?.()
              markFirstRunReady = null
            })
            yield 'Old reply that should be dropped'
            return
          }

          yield 'Steered'
          yield ' reply'
        }
      })
    }
  )
})

test('YachiyoServer persists assistant text blocks around tool calls', async () => {
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
        content: 'Split the assistant message around tools'
      })

      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const assistantMessage = bootstrap.messagesByThread[thread.id]?.find(
        (message) => message.role === 'assistant'
      )

      assert.deepEqual(
        assistantMessage?.textBlocks?.map((textBlock) => textBlock.content),
        ['Before tool', 'After tool']
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          yield 'Before tool'

          request.onToolCallStart?.({
            abortSignal: request.signal,
            experimental_context: undefined,
            functionId: undefined,
            messages: request.messages,
            metadata: undefined,
            model: undefined,
            stepNumber: 0,
            toolCall: {
              input: { filePath: '/tmp/example.txt' },
              toolCallId: 'tool-read-1',
              toolName: 'read'
            }
          } as never)

          request.onToolCallFinish?.({
            abortSignal: request.signal,
            durationMs: 1,
            experimental_context: undefined,
            functionId: undefined,
            messages: request.messages,
            metadata: undefined,
            model: undefined,
            stepNumber: 0,
            success: true,
            output: {
              content: [{ type: 'text', text: 'ok' }],
              details: {
                path: '/tmp/example.txt',
                startLine: 1,
                endLine: 1,
                totalLines: 1,
                totalBytes: 2,
                truncated: false
              },
              metadata: {}
            },
            toolCall: {
              input: { filePath: '/tmp/example.txt' },
              toolCallId: 'tool-read-1',
              toolName: 'read'
            }
          } as never)

          yield 'After tool'
        }
      })
    }
  )
})

test('YachiyoServer delays steer restart until the running tool call finishes', async () => {
  const requests: ModelStreamRequest[] = []
  let attempt = 0
  let firstRequest: ModelStreamRequest | null = null
  const toolUpdates: Array<{ assistantMessageId?: string; status: string }> = []
  let releaseToolExecution: (() => void) | null = null
  let markToolExecutionStarted: (() => void) | null = null
  const toolExecutionStarted = new Promise<void>((resolve) => {
    markToolExecutionStarted = resolve
  })

  await withServer(
    async ({ server, completeRun }) => {
      const unsubscribe = server.subscribe((event) => {
        if (event.type !== 'tool.updated') {
          return
        }

        if (event.runId !== acceptedRunId) {
          return
        }

        toolUpdates.push({
          ...(event.toolCall.assistantMessageId
            ? { assistantMessageId: event.toolCall.assistantMessageId }
            : {}),
          status: event.toolCall.status
        })
      })
      let acceptedRunId = ''

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
        content: 'List the workspace files.'
      })
      assertAcceptedHasUserMessage(accepted)
      acceptedRunId = accepted.runId

      await toolExecutionStarted

      const steerAccepted = await server.sendChat({
        threadId: thread.id,
        content: 'Actually summarize the result instead',
        mode: 'steer'
      })
      const beforeRelease = await server.bootstrap()

      assert.equal(steerAccepted.kind, 'active-run-steer-pending')
      assert.equal(firstRequest?.signal.aborted, false)
      assert.equal(requests.length, 1)
      assert.equal((beforeRelease.messagesByThread[thread.id] ?? []).length, 1)

      releaseToolExecution?.()
      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const messages = bootstrap.messagesByThread[thread.id] ?? []
      const toolCalls = bootstrap.toolCallsByThread[thread.id] ?? []

      assert.equal(firstRequest?.signal.aborted, true)
      assert.equal(requests.length, 2)
      assert.ok(
        requests[1]?.messages.some(
          (message) =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) => part.type === 'text' && part.text === 'Checking the workspace'
            )
        ),
        'restart prompt should keep the interrupted assistant turn'
      )
      assert.ok(
        requests[1]?.messages.some(
          (message) =>
            message.role === 'tool' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) => part.type === 'tool-result' && part.toolCallId === 'tool-bash-1'
            )
        ),
        'restart prompt should keep the tool result'
      )
      assert.equal(requests[1]?.messages.at(-1)?.role, 'user')
      assert.ok(
        String(requests[1]?.messages.at(-1)?.content).startsWith(
          'Actually summarize the result instead'
        )
      )
      assert.equal(toolCalls.length, 1)
      assert.equal(toolCalls[0]?.status, 'completed')
      assert.equal(toolCalls[0]?.outputSummary, 'exit 0')
      assert.equal(toolCalls[0]?.error, undefined)
      assert.deepEqual(
        toolUpdates.map((toolCall) => toolCall.status),
        ['running', 'completed', 'completed']
      )
      const stoppedAssistant = messages.find(
        (message) => message.role === 'assistant' && message.status === 'stopped'
      )
      const steerMessage = messages.find(
        (message) =>
          message.role === 'user' && message.content === 'Actually summarize the result instead'
      )
      const finalAssistant = messages.find(
        (message) => message.role === 'assistant' && message.content === 'Steered reply'
      )

      assert.equal(messages[0]?.content, 'List the workspace files.')
      assert.ok(stoppedAssistant)
      assert.ok(steerMessage)
      assert.ok(finalAssistant)
      assert.equal(stoppedAssistant?.content, 'Checking the workspace')
      assert.equal(steerMessage?.parentMessageId, stoppedAssistant?.id)
      assert.equal(finalAssistant?.parentMessageId, steerMessage?.id)
      assert.equal(toolUpdates[0]?.assistantMessageId, undefined)
      assert.equal(toolUpdates[1]?.assistantMessageId, undefined)
      assert.equal(toolUpdates[2]?.assistantMessageId, finalAssistant?.id)
      unsubscribe()
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (attempt === 0) {
            attempt += 1
            firstRequest = request

            yield 'Checking the workspace'

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
            markToolExecutionStarted?.()
            markToolExecutionStarted = null

            await new Promise<void>((resolve) => {
              releaseToolExecution = resolve
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

          yield 'Steered'
          yield ' reply'
        }
      })
    }
  )
})

test('YachiyoServer recovers a committed transport failure and resumes from preserved tool history', async () => {
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
        content: 'Inspect the workspace and finish the answer.'
      })
      assertAcceptedHasUserMessage(accepted)

      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const messages = bootstrap.messagesByThread[thread.id] ?? []
      const toolCalls = bootstrap.toolCallsByThread[thread.id] ?? []
      const finalAssistant = messages.find(
        (message) =>
          message.role === 'assistant' && message.parentMessageId === accepted.userMessage.id
      )

      assert.equal(requests.length, 2)
      assert.ok(
        requests[1]?.messages.some(
          (message) =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) => part.type === 'text' && part.text === 'Checking the workspace. '
            )
        ),
        'recovery prompt should keep the partial assistant text'
      )
      assert.ok(
        requests[1]?.messages.some(
          (message) =>
            message.role === 'tool' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) => part.type === 'tool-result' && part.toolCallId === 'tool-bash-recover-1'
            )
        ),
        'recovery prompt should keep the completed tool result'
      )
      assert.equal(requests[1]?.messages.at(-1)?.role, 'user')
      assert.ok(
        String(requests[1]?.messages.at(-1)?.content).includes(
          'The previous assistant response was interrupted by a recoverable transport failure.'
        )
      )
      assert.equal(toolCalls.length, 1)
      assert.equal(toolCalls[0]?.status, 'completed')
      assert.equal(toolCalls[0]?.outputSummary, 'exit 0')
      assert.equal(finalAssistant?.content, 'Checking the workspace. Final answer.')
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (attempt === 0) {
            attempt += 1

            yield 'Checking the workspace. '

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
                toolCallId: 'tool-bash-recover-1',
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
                toolCallId: 'tool-bash-recover-1',
                toolName: 'bash'
              }
            } as never)

            const error = new Error('net::ERR_CONNECTION_CLOSED') as Error & {
              status?: number
            }
            error.status = 0
            throw error
          }

          yield 'Final answer.'
        }
      })
    }
  )
})

test('YachiyoServer preserves fresh continuation text when a recovered run does not replay the prefix', async () => {
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
        content: 'Continue from the saved work without repeating it.'
      })
      assertAcceptedHasUserMessage(accepted)

      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const finalAssistant = (bootstrap.messagesByThread[thread.id] ?? []).find(
        (message) =>
          message.role === 'assistant' && message.parentMessageId === accepted.userMessage.id
      )

      assert.equal(
        finalAssistant?.content,
        'Checking the workspace. Continuing from the saved work.'
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply() {
          if (attempt === 0) {
            attempt += 1
            yield 'Checking the workspace. '

            const error = new Error('net::ERR_CONNECTION_CLOSED') as Error & {
              status?: number
            }
            error.status = 0
            throw error
          }

          yield 'C'
          yield 'ontinuing from the saved work.'
        }
      })
    }
  )
})

test('YachiyoServer preserves assistant-tool-assistant ordering across recovery', async () => {
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
        content: 'Inspect the workspace and continue after the tool result.'
      })
      assertAcceptedHasUserMessage(accepted)

      await completeRun(accepted.runId)

      assert.equal(requests.length, 2)
      const recoveryMessages = requests[1]?.messages ?? []
      const trailingAssistantIndex = recoveryMessages.findIndex(
        (message) =>
          message.role === 'assistant' &&
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === 'text' && part.text === 'After tool. ')
      )
      const toolResultIndex = recoveryMessages.findIndex(
        (message) =>
          message.role === 'tool' &&
          Array.isArray(message.content) &&
          message.content.some(
            (part) =>
              part.type === 'tool-result' &&
              part.toolCallId === 'tool-bash-order-1' &&
              part.output?.type === 'content' &&
              Array.isArray(part.output.value) &&
              part.output.value[0]?.type === 'text' &&
              part.output.value[0]?.text === '/tmp/workspace'
          )
      )
      const continuationPromptIndex = recoveryMessages.findIndex(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes(
            'The previous assistant response was interrupted by a recoverable transport failure.'
          )
      )

      assert.notEqual(toolResultIndex, -1)
      assert.notEqual(trailingAssistantIndex, -1)
      assert.notEqual(continuationPromptIndex, -1)
      assert.ok(
        toolResultIndex < trailingAssistantIndex &&
          trailingAssistantIndex < continuationPromptIndex,
        'recovery should preserve the assistant text that happened after the tool result'
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (attempt === 0) {
            attempt += 1

            yield 'Before tool. '

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
                toolCallId: 'tool-bash-order-1',
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
                toolCallId: 'tool-bash-order-1',
                toolName: 'bash'
              }
            } as never)

            yield 'After tool. '

            const error = new Error('net::ERR_CONNECTION_CLOSED') as Error & {
              status?: number
            }
            error.status = 0
            throw error
          }

          yield 'Final answer.'
        }
      })
    }
  )
})

test('YachiyoServer ignores late tool updates after a tool call has already finished', async () => {
  const toolUpdates: Array<{ assistantMessageId?: string; status: string }> = []

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
        content: 'List the workspace files.'
      })
      assertAcceptedHasUserMessage(accepted)

      const unsubscribe = server.subscribe((event) => {
        if (event.type !== 'tool.updated' || event.runId !== accepted.runId) {
          return
        }

        toolUpdates.push({
          ...(event.toolCall.assistantMessageId
            ? { assistantMessageId: event.toolCall.assistantMessageId }
            : {}),
          status: event.toolCall.status
        })
      })

      await completeRun(accepted.runId)
      unsubscribe()

      const bootstrap = await server.bootstrap()
      const toolCalls = bootstrap.toolCallsByThread[thread.id] ?? []

      assert.equal(toolCalls.length, 1)
      assert.equal(toolCalls[0]?.status, 'completed')
      assert.equal(toolCalls[0]?.outputSummary, 'exit 0')
      assert.equal(typeof toolCalls[0]?.finishedAt, 'string')
      assert.deepEqual(
        toolUpdates.map((toolCall) => toolCall.status),
        ['running', 'completed', 'completed']
      )
      assert.equal(toolUpdates[0]?.assistantMessageId, undefined)
      assert.equal(toolUpdates[1]?.assistantMessageId, undefined)
      assert.equal(toolUpdates[2]?.assistantMessageId, toolCalls[0]?.assistantMessageId)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
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

          request.onToolCallUpdate?.({
            output: {
              content: [{ type: 'text', text: '/tmp/workspace\n' }],
              details: {
                command: 'pwd',
                cwd: '/tmp/workspace',
                stderr: '',
                stdout: '/tmp/workspace\n'
              },
              metadata: {
                cwd: '/tmp/workspace'
              }
            },
            toolCall: {
              input: { command: 'pwd' },
              toolCallId: 'tool-bash-1',
              toolName: 'bash'
            }
          } as never)

          yield 'Done'
        }
      }),
      now: (() => {
        let tick = 0
        return () => new Date(`2026-03-15T00:00:${String(tick++).padStart(2, '0')}.000Z`)
      })()
    }
  )
})

test('YachiyoServer persists tool finishes that arrive without a prior tool start event', async () => {
  const toolUpdates: Array<{ assistantMessageId?: string; status: string }> = []

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
        content: 'List the workspace files.'
      })
      assertAcceptedHasUserMessage(accepted)

      const unsubscribe = server.subscribe((event) => {
        if (event.type !== 'tool.updated' || event.runId !== accepted.runId) {
          return
        }

        toolUpdates.push({
          ...(event.toolCall.assistantMessageId
            ? { assistantMessageId: event.toolCall.assistantMessageId }
            : {}),
          status: event.toolCall.status
        })
      })

      await completeRun(accepted.runId)
      unsubscribe()

      const bootstrap = await server.bootstrap()
      const toolCalls = bootstrap.toolCallsByThread[thread.id] ?? []

      assert.equal(toolCalls.length, 1)
      assert.equal(toolCalls[0]?.status, 'completed')
      assert.equal(toolCalls[0]?.toolName, 'bash')
      assert.equal(toolCalls[0]?.inputSummary, 'pwd')
      assert.equal(toolCalls[0]?.outputSummary, 'exit 0')
      assert.equal(toolCalls[0]?.requestMessageId, accepted.userMessage.id)
      assert.equal(typeof toolCalls[0]?.assistantMessageId, 'string')
      assert.deepEqual(
        toolUpdates.map((toolCall) => toolCall.status),
        ['completed', 'completed']
      )
      assert.equal(toolUpdates[0]?.assistantMessageId, undefined)
      assert.equal(toolUpdates[1]?.assistantMessageId, toolCalls[0]?.assistantMessageId)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
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

          yield 'Done'
        }
      })
    }
  )
})

test('YachiyoServer emits thread.state.replaced with the steer message when a pending steer fires after the tool finishes', async () => {
  const requests: ModelStreamRequest[] = []
  let attempt = 0
  let releaseToolExecution: (() => void) | null = null
  let markToolExecutionStarted: (() => void) | null = null
  const toolExecutionStarted = new Promise<void>((resolve) => {
    markToolExecutionStarted = resolve
  })

  await withServer(
    async ({ server, completeRun, waitForEvent }) => {
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
        content: 'List the workspace files.'
      })
      assertAcceptedHasUserMessage(accepted)

      await toolExecutionStarted

      const steerAccepted = await server.sendChat({
        threadId: thread.id,
        content: 'Actually summarize the result instead',
        mode: 'steer'
      })

      assert.equal(steerAccepted.kind, 'active-run-steer-pending')

      releaseToolExecution?.()

      const stateReplaced = (await waitForEvent('thread.state.replaced')) as {
        threadId: string
        thread: { headMessageId?: string }
        messages: Array<{ id: string; role: string; content: string }>
        toolCalls: Array<{ status: string; requestMessageId?: string }>
      }

      assert.equal(stateReplaced.threadId, thread.id)
      assert.equal(stateReplaced.messages.length, 2)
      assert.equal(stateReplaced.messages[0]?.role, 'user')
      assert.equal(stateReplaced.messages[0]?.content, 'List the workspace files.')
      assert.equal(stateReplaced.messages[1]?.role, 'user')
      assert.equal(stateReplaced.messages[1]?.content, 'Actually summarize the result instead')
      assert.equal(stateReplaced.toolCalls.length, 1)
      assert.equal(stateReplaced.toolCalls[0]?.status, 'completed')
      assert.equal(stateReplaced.toolCalls[0]?.requestMessageId, stateReplaced.messages[0]?.id)

      await completeRun(accepted.runId)
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

            markToolExecutionStarted?.()
            markToolExecutionStarted = null

            await new Promise<void>((resolve) => {
              releaseToolExecution = resolve
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

          yield 'Steered'
          yield ' reply'
        }
      })
    }
  )
})

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

test('YachiyoServer replaces the queued follow-up for an active run and starts the replacement next', async () => {
  const requests: ModelStreamRequest[] = []
  let releaseFirstRun: (() => void) | null = null

  await withServer(
    async ({ server, completeRun, waitForEvent }) => {
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
      const firstRun = await server.sendChat({
        threadId: thread.id,
        content: 'First question'
      })
      const createdRun = (await waitForEvent('run.created')) as { runId: string }

      assert.equal(createdRun.runId, firstRun.runId)
      await waitForEvent('message.delta')

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

      releaseFirstRun?.()
      await completeRun(firstRun.runId)
      const followUpRunCreated = (await waitForEvent('run.created')) as { runId: string }
      await completeRun(followUpRunCreated.runId)

      const bootstrap = await server.bootstrap()

      assert.equal(bootstrap.threads[0]?.queuedFollowUpMessageId, undefined)
      assert.deepEqual(
        (bootstrap.messagesByThread[thread.id] ?? []).map((message) => message.content),
        ['First question', 'Second queued follow-up', 'Hello world', 'Queued follow-up reply']
      )
      assert.ok(String(requests[1]?.messages.at(-1)?.content).startsWith('Second queued follow-up'))
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (requests.length === 1) {
            yield 'Hello'
            await new Promise<void>((resolve) => {
              releaseFirstRun = resolve
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

test('YachiyoServer emits a replacement snapshot when a queued follow-up is reparented onto the completed reply branch', async () => {
  let releaseRetryRun: (() => void) | null = null
  let requestCount = 0

  await withServer(
    async ({ server, completeRun, waitForEvent }) => {
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

      const replacementEventPromise = waitForEvent('thread.state.replaced') as Promise<
        Extract<YachiyoServerEvent, { type: 'thread.state.replaced' }>
      >

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

      const followUpRunCreated = (await waitForEvent('run.created')) as { runId: string }
      await completeRun(followUpRunCreated.runId)
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

            const error = new Error('net::ERR_CONNECTION_CLOSED') as Error & {
              status?: number
            }
            error.status = 0
            throw error
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
      assert.equal(bootstrap.latestRunsByThread['thread-1']?.error, 'net::ERR_CONNECTION_CLOSED')
      assert.equal(storage.getRunRecoveryCheckpoint('run-1'), undefined)
    } finally {
      waiter.close()
      await resumedServer.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('YachiyoServer bootstrap resumes a persisted queued follow-up with its queued tool override', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-queued-recover-test-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(settingsPath, '[toolModel]\nmode = "disabled"\n', 'utf8')
  const userDocumentPath = join(root, '.yachiyo', 'USER.md')
  const storage = createInMemoryYachiyoStorage()
  const workspacePathForThread = (threadId: string): string =>
    join(root, '.yachiyo', 'temp-workspace', threadId)

  const firstServer = new YachiyoServer({
    storage,
    settingsPath,
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
        yield ''
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
      }
    })
  })
  const firstWaiter = createServerEventWaiter(firstServer)
  let firstServerClosed = false

  try {
    await firstServer.upsertProvider({
      name: 'work',
      type: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      modelList: {
        enabled: ['gpt-5'],
        disabled: []
      }
    })

    const thread = await firstServer.createThread()
    await firstServer.sendChat({
      threadId: thread.id,
      content: 'First question'
    })

    const queuedFollowUp = await firstServer.sendChat({
      threadId: thread.id,
      content: 'Recovered queued follow-up',
      enabledTools: ['read'],
      mode: 'follow-up'
    })
    assertAcceptedHasUserMessage(queuedFollowUp)
    await firstServer.saveToolPreferences({ enabledTools: ['bash'] })

    await firstServer.close()
    firstServerClosed = true
    firstWaiter.close()

    const resumedRequests: ModelStreamRequest[] = []
    const resumedServer = new YachiyoServer({
      storage,
      settingsPath,
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
          yield 'Recovered'
          yield ' reply'
        }
      })
    })
    const resumedWaiter = createServerEventWaiter(resumedServer)

    try {
      const bootstrap = await resumedServer.bootstrap()
      const bootstrappedThread = bootstrap.threads.find((entry) => entry.id === thread.id)

      assert.equal(bootstrappedThread?.queuedFollowUpMessageId, queuedFollowUp.userMessage.id)
      assert.deepEqual(bootstrappedThread?.queuedFollowUpEnabledTools, ['read'])
      assert.match(
        bootstrap.latestRunsByThread[thread.id]?.status ?? '',
        /^(cancelled|failed)$/,
        'bootstrap should preserve the prior run terminal state before the queued follow-up resumes'
      )

      const replacementEvent = await resumedWaiter.waitForEvent(
        'thread.state.replaced',
        (event) => event.threadId === thread.id
      )
      const resumedRunCreated = await resumedWaiter.waitForEvent(
        'run.created',
        (event) =>
          event.threadId === thread.id && event.requestMessageId === queuedFollowUp.userMessage.id
      )
      await resumedWaiter.waitForEvent(
        'run.completed',
        (event) => event.runId === resumedRunCreated.runId
      )

      assert.equal(replacementEvent.thread.headMessageId, queuedFollowUp.userMessage.id)
      assert.equal(replacementEvent.thread.queuedFollowUpMessageId, undefined)
      const recoveredBootstrap = await resumedServer.bootstrap()

      assert.deepEqual(
        (recoveredBootstrap.messagesByThread[thread.id] ?? []).map((message) => message.content),
        ['First question', 'Recovered queued follow-up', '', 'Recovered reply']
      )
      assert.match(
        String(resumedRequests[0]?.messages.at(-1)?.content ?? ''),
        /Recovered queued follow-up/
      )
      const resumedToolKeys = Object.keys(resumedRequests[0]?.tools ?? {}).sort()
      for (const expected of ['askUser', 'read', 'update_profile']) {
        assert.ok(resumedToolKeys.includes(expected), `should include ${expected}`)
      }
    } finally {
      resumedWaiter.close()
      await resumedServer.close()
    }
  } finally {
    if (!firstServerClosed) {
      firstWaiter.close()
      await firstServer.close()
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('YachiyoServer keeps a recovered queued follow-up pending when a new run starts immediately after bootstrap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-queued-race-test-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(settingsPath, '[toolModel]\nmode = "disabled"\n', 'utf8')
  const userDocumentPath = join(root, '.yachiyo', 'USER.md')
  const storage = createInMemoryYachiyoStorage()
  const workspacePathForThread = (threadId: string): string =>
    join(root, '.yachiyo', 'temp-workspace', threadId)

  const firstServer = new YachiyoServer({
    storage,
    settingsPath,
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
        yield ''
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
      }
    })
  })
  const firstWaiter = createServerEventWaiter(firstServer)
  let firstServerClosed = false

  try {
    await firstServer.upsertProvider({
      name: 'work',
      type: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      modelList: {
        enabled: ['gpt-5'],
        disabled: []
      }
    })
    await firstServer.saveToolPreferences({ enabledTools: ['bash'] })

    const thread = await firstServer.createThread()
    await firstServer.sendChat({
      threadId: thread.id,
      content: 'First question'
    })

    const queuedFollowUp = await firstServer.sendChat({
      threadId: thread.id,
      content: 'Recovered queued follow-up',
      enabledTools: ['read'],
      mode: 'follow-up'
    })
    assertAcceptedHasUserMessage(queuedFollowUp)

    await firstServer.close()
    firstServerClosed = true
    firstWaiter.close()

    const resumedRequests: Array<{ content: unknown; toolNames: string[] }> = []
    const resumedServer = new YachiyoServer({
      storage,
      settingsPath,
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
          resumedRequests.push({
            content: request.messages.at(-1)?.content,
            toolNames: Object.keys(request.tools ?? {}).sort()
          })

          if (resumedRequests.length === 1) {
            yield 'Immediate'
            yield ' reply'
            return
          }

          yield 'Recovered'
          yield ' reply'
        }
      })
    })
    const resumedWaiter = createServerEventWaiter(resumedServer)

    try {
      const bootstrap = await resumedServer.bootstrap()
      const bootstrappedThread = bootstrap.threads.find((entry) => entry.id === thread.id)

      assert.equal(bootstrappedThread?.queuedFollowUpMessageId, queuedFollowUp.userMessage.id)
      assert.deepEqual(bootstrappedThread?.queuedFollowUpEnabledTools, ['read'])

      const immediateAccepted = await resumedServer.sendChat({
        threadId: thread.id,
        content: 'Immediate question'
      })
      assertAcceptedHasUserMessage(immediateAccepted)

      await resumedWaiter.waitForEvent(
        'run.created',
        (event) => event.runId === immediateAccepted.runId
      )
      await resumedWaiter.waitForEvent(
        'run.completed',
        (event) => event.runId === immediateAccepted.runId
      )

      const recoveredRunCreated = await resumedWaiter.waitForEvent(
        'run.created',
        (event) => event.requestMessageId === queuedFollowUp.userMessage.id
      )
      await resumedWaiter.waitForEvent(
        'run.completed',
        (event) => event.runId === recoveredRunCreated.runId
      )

      const recoveredBootstrap = await resumedServer.bootstrap()
      const queuedMessage = (recoveredBootstrap.messagesByThread[thread.id] ?? []).find(
        (message) => message.id === queuedFollowUp.userMessage.id
      )
      const immediateAssistantMessage = (recoveredBootstrap.messagesByThread[thread.id] ?? []).find(
        (message) => message.role === 'assistant' && message.content === 'Immediate reply'
      )

      assert.equal(
        recoveredBootstrap.threads.find((entry) => entry.id === thread.id)?.queuedFollowUpMessageId,
        undefined
      )
      assert.equal(queuedMessage?.parentMessageId, immediateAssistantMessage?.id)
      assert.ok(String(resumedRequests[0]?.content).startsWith('Immediate question'))
      for (const expected of ['askUser', 'bash', 'update_profile']) {
        assert.ok(
          resumedRequests[0]?.toolNames?.includes(expected),
          `run 0 should include ${expected}`
        )
      }
      assert.match(String(resumedRequests[1]?.content ?? ''), /Recovered queued follow-up/)
      for (const expected of ['askUser', 'read', 'update_profile']) {
        assert.ok(
          resumedRequests[1]?.toolNames?.includes(expected),
          `run 1 should include ${expected}`
        )
      }
    } finally {
      resumedWaiter.close()
      await resumedServer.close()
    }
  } finally {
    if (!firstServerClosed) {
      firstWaiter.close()
      await firstServer.close()
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('YachiyoServer close waits for active runs to persist a terminal status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-close-test-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(settingsPath, '[toolModel]\nmode = "disabled"\n', 'utf8')
  const userDocumentPath = join(root, '.yachiyo', 'USER.md')
  const storage = createInMemoryYachiyoStorage()
  const server = new YachiyoServer({
    storage,
    settingsPath,
    readSoulDocument: async () => null,
    readUserDocument: () => readUserDocument({ filePath: userDocumentPath }),
    saveUserDocument: (content) => writeUserDocument({ filePath: userDocumentPath, content }),
    ensureThreadWorkspace: async (threadId) => {
      const workspacePath = join(root, '.yachiyo', 'temp-workspace', threadId)
      await mkdir(workspacePath, { recursive: true })
      return workspacePath
    },
    createModelRuntime: () => ({
      async *streamReply(request: ModelStreamRequest) {
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

        yield 'unreachable'
      }
    })
  })

  try {
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
    await server.sendChat({
      threadId: thread.id,
      content: 'Close while running'
    })

    await server.close()

    const bootstrap = storage.bootstrap()
    assert.equal(bootstrap.latestRunsByThread[thread.id]?.status, 'cancelled')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('YachiyoServer renames and archives threads', async () => {
  await withServer(async ({ server }) => {
    const first = await server.createThread()
    const second = await server.createThread()

    const renamed = await server.renameThread({
      threadId: first.id,
      title: 'Pinned plan'
    })

    assert.equal(renamed.title, 'Pinned plan')

    await server.archiveThread({ threadId: second.id })

    const bootstrap = await server.bootstrap()

    assert.equal(bootstrap.threads.length, 1)
    assert.equal(bootstrap.threads[0]?.id, first.id)
    assert.equal(bootstrap.threads[0]?.title, 'Pinned plan')
    assert.equal(bootstrap.archivedThreads[0]?.id, second.id)
  })
})

test('YachiyoServer restores and deletes archived threads', async () => {
  await withServer(async ({ server, workspacePathForThread }) => {
    const first = await server.createThread()
    const second = await server.createThread()
    await mkdir(workspacePathForThread(second.id), { recursive: true })
    await writeFile(join(workspacePathForThread(second.id), 'notes.txt'), 'keep me', 'utf8')

    await server.archiveThread({ threadId: second.id })

    let bootstrap = await server.bootstrap()
    assert.deepEqual(
      bootstrap.threads.map((thread) => thread.id),
      [first.id]
    )
    assert.deepEqual(
      bootstrap.archivedThreads.map((thread) => thread.id),
      [second.id]
    )

    const restored = await server.restoreThread({ threadId: second.id })
    assert.equal(restored.id, second.id)
    assert.equal(restored.archivedAt, undefined)

    bootstrap = await server.bootstrap()
    assert.deepEqual(
      bootstrap.threads.map((thread) => thread.id).sort(),
      [first.id, second.id].sort()
    )
    assert.deepEqual(bootstrap.archivedThreads, [])

    await server.deleteThread({ threadId: second.id })

    bootstrap = await server.bootstrap()
    assert.deepEqual(
      bootstrap.threads.map((thread) => thread.id),
      [first.id]
    )
    assert.deepEqual(bootstrap.archivedThreads, [])
    await assert.rejects(access(workspacePathForThread(second.id)))
  })
})

test('YachiyoServer keeps retry replies as sibling assistant branches and preserves them across branch/delete operations', async () => {
  await withServer(async ({ server, completeRun }) => {
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

    const firstRun = await server.sendChat({
      threadId: thread.id,
      content: 'First question'
    })
    await completeRun(firstRun.runId)

    let bootstrap = await server.bootstrap()
    const [firstUser, firstAssistant] = bootstrap.messagesByThread[thread.id] ?? []

    assert.equal(firstUser?.role, 'user')
    assert.equal(firstAssistant?.role, 'assistant')
    assert.equal(firstAssistant?.parentMessageId, firstUser?.id)

    const secondRun = await server.sendChat({
      threadId: thread.id,
      content: 'Second question'
    })
    await completeRun(secondRun.runId)

    bootstrap = await server.bootstrap()
    const [, , secondUser, secondAssistant] = bootstrap.messagesByThread[thread.id] ?? []

    assert.equal(secondUser?.parentMessageId, firstAssistant?.id)
    assert.equal(secondAssistant?.parentMessageId, secondUser?.id)

    const retryRun = await server.retryMessage({
      threadId: thread.id,
      messageId: firstAssistant!.id
    })
    await completeRun(retryRun.runId)

    bootstrap = await server.bootstrap()
    const retriedAssistant = (bootstrap.messagesByThread[thread.id] ?? []).find(
      (message) => message.id !== firstAssistant?.id && message.parentMessageId === firstUser?.id
    )

    assert.equal(bootstrap.threads.length, 1)
    assert.equal(retriedAssistant?.role, 'assistant')
    assert.equal(retriedAssistant?.parentMessageId, firstUser?.id)
    assert.equal(
      bootstrap.threads[0]?.headMessageId,
      retriedAssistant?.id,
      'historical retry should replace the current thread head with the new reply branch'
    )

    const branched = await server.createBranch({
      threadId: thread.id,
      messageId: retriedAssistant!.id
    })

    assert.equal(branched.thread.branchFromThreadId, thread.id)
    assert.equal(branched.thread.branchFromMessageId, retriedAssistant?.id)
    assert.equal(branched.thread.headMessageId, branched.messages[1]?.id)
    assert.equal(branched.messages.length, 2)
    assert.equal(branched.messages[0]?.role, 'user')
    assert.equal(branched.messages[1]?.role, 'assistant')
    assert.equal(branched.messages[1]?.parentMessageId, branched.messages[0]?.id)

    const deleted = await server.deleteMessageFromHere({
      threadId: thread.id,
      messageId: firstAssistant!.id
    })

    assert.deepEqual(
      deleted.messages.map((message) => message.id),
      [firstUser!.id, retriedAssistant!.id]
    )
    assert.equal(deleted.thread.headMessageId, retriedAssistant?.id)
    assert.equal(deleted.messages[1]?.parentMessageId, firstUser?.id)
  })
})

test('YachiyoServer removes tool activity for a deleted assistant-only branch without touching sibling retries', async () => {
  let runAttempt = 0

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
      const firstRun = await server.sendChat({
        threadId: thread.id,
        content: 'First question'
      })
      await completeRun(firstRun.runId)

      let bootstrap = await server.bootstrap()
      const [firstUser, firstAssistant] = bootstrap.messagesByThread[thread.id] ?? []

      const retryRun = await server.retryMessage({
        threadId: thread.id,
        messageId: firstAssistant!.id
      })
      await completeRun(retryRun.runId)

      bootstrap = await server.bootstrap()
      const retriedAssistant = (bootstrap.messagesByThread[thread.id] ?? []).find(
        (message) => message.id !== firstAssistant?.id && message.parentMessageId === firstUser?.id
      )
      const toolCallsBeforeDelete = bootstrap.toolCallsByThread[thread.id] ?? []

      assert.deepEqual(
        toolCallsBeforeDelete.map((toolCall) => toolCall.id),
        ['tool-1', 'tool-2']
      )

      const deleted = await server.deleteMessageFromHere({
        threadId: thread.id,
        messageId: firstAssistant!.id
      })

      assert.deepEqual(
        deleted.messages.map((message) => message.id),
        [firstUser!.id, retriedAssistant!.id]
      )
      assert.deepEqual(
        deleted.toolCalls.map((toolCall) => toolCall.id),
        ['tool-2']
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          runAttempt += 1
          const toolCallId = `tool-${runAttempt}`
          request.onToolCallStart?.({
            abortSignal: request.signal,
            experimental_context: undefined,
            functionId: undefined,
            messages: request.messages,
            metadata: undefined,
            model: undefined,
            stepNumber: 0,
            toolCall: {
              input: { path: `notes-${runAttempt}.txt` },
              toolCallId,
              toolName: 'read'
            }
          } as never)
          request.onToolCallFinish?.({
            abortSignal: request.signal,
            durationMs: 1,
            experimental_context: undefined,
            functionId: undefined,
            messages: request.messages,
            metadata: undefined,
            model: undefined,
            stepNumber: 0,
            success: true,
            output: {
              content: [{ type: 'text', text: 'hello' }],
              details: {
                endLine: 1,
                path: `/tmp/notes-${runAttempt}.txt`,
                startLine: 1,
                totalBytes: 5,
                totalLines: 1,
                truncated: false
              },
              metadata: {}
            },
            toolCall: {
              input: { path: `notes-${runAttempt}.txt` },
              toolCallId,
              toolName: 'read'
            }
          } as never)

          yield `Answer ${runAttempt}`
        }
      })
    }
  )
})

test('YachiyoServer copies the source workspace when creating a branch thread', async () => {
  await withServer(async ({ server, completeRun, workspacePathForThread }) => {
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
      content: 'Branch this thread'
    })
    await completeRun(accepted.runId)

    const bootstrap = await server.bootstrap()
    const assistantMessage = bootstrap.messagesByThread[thread.id]?.[1]
    const sourceWorkspacePath = workspacePathForThread(thread.id)
    const nestedDirectoryPath = join(sourceWorkspacePath, 'nested')
    const sourceFilePath = join(nestedDirectoryPath, 'notes.txt')
    await mkdir(nestedDirectoryPath, { recursive: true })
    await writeFile(sourceFilePath, 'workspace snapshot', 'utf8')

    const branch = await server.createBranch({
      threadId: thread.id,
      messageId: assistantMessage!.id
    })

    const branchFilePath = join(workspacePathForThread(branch.thread.id), 'nested', 'notes.txt')
    assert.equal(await readFile(branchFilePath, 'utf8'), 'workspace snapshot')
  })
})

test('YachiyoServer allows changing a fresh branch workspace before the first new message', async () => {
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
        content: 'Branch this thread'
      })
      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const assistantMessage = bootstrap.messagesByThread[thread.id]?.[1]
      const branch = await server.createBranch({
        threadId: thread.id,
        messageId: assistantMessage!.id
      })

      const customWorkspace = join(tmpdir(), 'yachiyo-branch-custom-workspace')
      const updatedBranch = await server.updateThreadWorkspace({
        threadId: branch.thread.id,
        workspacePath: customWorkspace
      })
      assert.equal(updatedBranch.workspacePath, customWorkspace)

      const followUp = await server.sendChat({
        threadId: branch.thread.id,
        content: 'Now continue on the branch'
      })
      await completeRun(followUp.runId)

      await assert.rejects(
        server.updateThreadWorkspace({
          threadId: branch.thread.id,
          workspacePath: null
        }),
        /before the first message is sent/
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply(): AsyncIterable<string> {
          yield 'Done'
        }
      })
    }
  )
})

test('YachiyoServer can switch the active thread branch between sibling replies', async () => {
  let tick = 0
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

      const firstRun = await server.sendChat({
        threadId: thread.id,
        content: 'First question'
      })
      await completeRun(firstRun.runId)

      let bootstrap = await server.bootstrap()
      const [firstUser, firstAssistant] = bootstrap.messagesByThread[thread.id] ?? []

      const secondRun = await server.sendChat({
        threadId: thread.id,
        content: 'Second question'
      })
      await completeRun(secondRun.runId)

      bootstrap = await server.bootstrap()
      const [, , secondUser, secondAssistant] = bootstrap.messagesByThread[thread.id] ?? []

      const retryRun = await server.retryMessage({
        threadId: thread.id,
        messageId: firstAssistant!.id
      })
      await completeRun(retryRun.runId)

      bootstrap = await server.bootstrap()
      const retriedAssistant = (bootstrap.messagesByThread[thread.id] ?? []).find(
        (message) => message.id !== firstAssistant?.id && message.parentMessageId === firstUser?.id
      )
      const updatedAtBeforeSwitch = bootstrap.threads[0]?.updatedAt

      assert.equal(bootstrap.threads[0]?.headMessageId, retriedAssistant?.id)

      const followUpRun = await server.sendChat({
        threadId: thread.id,
        content: 'Follow up on the retry'
      })
      await completeRun(followUpRun.runId)

      bootstrap = await server.bootstrap()
      const retryFollowUpUser = (bootstrap.messagesByThread[thread.id] ?? []).find(
        (message) => message.content === 'Follow up on the retry'
      )
      const retryFollowUpAssistant = (bootstrap.messagesByThread[thread.id] ?? []).find(
        (message) =>
          message.parentMessageId === retryFollowUpUser?.id && message.role === 'assistant'
      )

      assert.equal(retryFollowUpUser?.parentMessageId, retriedAssistant?.id)
      assert.equal(bootstrap.threads[0]?.headMessageId, retryFollowUpAssistant?.id)

      const switchedBack = await server.selectReplyBranch({
        threadId: thread.id,
        assistantMessageId: firstAssistant!.id
      })

      assert.equal(switchedBack.headMessageId, secondAssistant?.id)
      assert.equal(switchedBack.preview, secondAssistant?.content)
      assert.notEqual(switchedBack.updatedAt, updatedAtBeforeSwitch)

      const switchedAgain = await server.selectReplyBranch({
        threadId: thread.id,
        assistantMessageId: retriedAssistant!.id
      })

      assert.equal(secondUser?.parentMessageId, firstAssistant?.id)
      assert.equal(switchedAgain.headMessageId, retryFollowUpAssistant?.id)
      assert.equal(switchedAgain.preview, retryFollowUpAssistant?.content)
      assert.ok(switchedAgain.updatedAt > switchedBack.updatedAt)
    },
    {
      now: () => new Date(Date.UTC(2026, 2, 15, 0, 0, tick++))
    }
  )
})

test('YachiyoServer recovers retry branches that only produced tool calls', async () => {
  let runAttempt = 0
  const requests: ModelStreamRequest[] = []

  await withServer(
    async ({ server, completeRun }) => {
      const thread = await server.createThread()

      const firstRun = await server.sendChat({
        threadId: thread.id,
        content: 'Question'
      })
      await completeRun(firstRun.runId)

      let bootstrap = await server.bootstrap()
      const [userMessage, firstAssistant] = bootstrap.messagesByThread[thread.id] ?? []

      const recoveredRetryRun = await server.retryMessage({
        threadId: thread.id,
        messageId: firstAssistant!.id
      })
      await completeRun(recoveredRetryRun.runId)

      bootstrap = await server.bootstrap()

      const recoveredRetryAssistant = (bootstrap.messagesByThread[thread.id] ?? []).find(
        (message) =>
          message.parentMessageId === userMessage?.id &&
          message.role === 'assistant' &&
          message.status === 'completed' &&
          message.id !== firstAssistant?.id
      )
      const recoveredRetryToolCalls = (bootstrap.toolCallsByThread[thread.id] ?? []).filter(
        (toolCall) => toolCall.runId === recoveredRetryRun.runId
      )

      assert.ok(
        requests[2]?.messages.some(
          (message) =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) =>
                part.type === 'tool-call' &&
                part.toolCallId === 'tool-retry-failed-1' &&
                'input' in part &&
                typeof part.input === 'object' &&
                part.input !== null &&
                'path' in part.input &&
                part.input.path === '/tmp/notes.txt'
            )
        )
      )
      assert.ok(recoveredRetryAssistant)
      assert.equal(recoveredRetryAssistant?.content, 'Recovered answer')
      assert.deepEqual(
        recoveredRetryToolCalls.map((toolCall) => toolCall.assistantMessageId),
        [recoveredRetryAssistant?.id]
      )

      const switched = await server.selectReplyBranch({
        threadId: thread.id,
        assistantMessageId: recoveredRetryAssistant!.id
      })

      assert.equal(switched.headMessageId, recoveredRetryAssistant?.id)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest): AsyncIterable<string> {
          requests.push(request)
          runAttempt += 1

          if (runAttempt === 1) {
            yield 'Original answer'
            return
          }

          if (runAttempt === 2) {
            request.onToolCallStart?.({
              abortSignal: request.signal,
              experimental_context: undefined,
              functionId: undefined,
              messages: request.messages,
              metadata: undefined,
              model: undefined,
              stepNumber: 0,
              toolCall: {
                input: { path: 'notes.txt' },
                toolCallId: 'tool-retry-failed-1',
                toolName: 'read'
              }
            } as never)
            request.onToolCallFinish?.({
              abortSignal: request.signal,
              durationMs: 1,
              experimental_context: undefined,
              functionId: undefined,
              messages: request.messages,
              metadata: undefined,
              model: undefined,
              stepNumber: 0,
              success: true,
              output: {
                content: [{ type: 'text', text: 'hello' }],
                details: {
                  endLine: 1,
                  path: '/tmp/notes.txt',
                  startLine: 1,
                  totalBytes: 5,
                  totalLines: 1,
                  truncated: false
                },
                metadata: {}
              },
              toolCall: {
                input: { path: 'notes.txt' },
                toolCallId: 'tool-retry-failed-1',
                toolName: 'read'
              }
            } as never)

            throw new Error('Tool-backed retry failure')
          }

          yield 'Recovered answer'
        }
      })
    }
  )
})

test('YachiyoServer deletes a user request anchor together with every attached response branch', async () => {
  await withServer(async ({ server, completeRun }) => {
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
      content: 'First question'
    })
    await completeRun(accepted.runId)

    let bootstrap = await server.bootstrap()
    const [userMessage, assistantMessage] = bootstrap.messagesByThread[thread.id] ?? []

    const retryRun = await server.retryMessage({
      threadId: thread.id,
      messageId: assistantMessage!.id
    })
    await completeRun(retryRun.runId)

    bootstrap = await server.bootstrap()
    assert.equal((bootstrap.messagesByThread[thread.id] ?? []).length, 3)

    const nextDelete = await server.deleteMessageFromHere({
      threadId: thread.id,
      messageId: userMessage!.id
    })

    assert.deepEqual(nextDelete.messages, [])
    assert.equal(nextDelete.thread.headMessageId, undefined)
  })
})

test('YachiyoServer manages provider config and active model state', async () => {
  await withServer(async ({ server, waitForEvent }) => {
    await server.upsertProvider({
      name: 'work',
      type: 'openai',
      apiKey: 'sk-openai',
      baseUrl: 'https://api.openai.com/v1',
      modelList: {
        enabled: ['gpt-5', 'gpt-4.1'],
        disabled: ['o3-mini']
      }
    })

    const updatedEvent = waitForEvent('settings.updated')

    const event = (await updatedEvent) as {
      settings: { providerName: string; provider: string; model: string }
      config: {
        providers: Array<{ name: string; modelList: { enabled: string[]; disabled: string[] } }>
      }
    }

    assert.equal(event.settings.providerName, 'work')
    assert.equal(event.settings.provider, 'openai')
    assert.equal(event.settings.model, 'gpt-5')
    assert.equal(event.config.providers.length, 1)
    assert.deepEqual(event.config.providers[0]?.modelList.enabled, ['gpt-5', 'gpt-4.1'])

    await server.disableProviderModel({
      name: 'work',
      model: 'gpt-5'
    })

    const config = await server.getConfig()
    assert.deepEqual(config.providers[0]?.modelList.enabled, ['gpt-4.1'])
    assert.deepEqual(config.providers[0]?.modelList.disabled, ['gpt-5', 'o3-mini'])

    const snapshot = await server.getSettings()
    assert.equal(snapshot.providerName, 'work')
    assert.equal(snapshot.provider, 'openai')
    assert.equal(snapshot.model, 'gpt-4.1')
    assert.equal(snapshot.apiKey, 'sk-openai')
  })
})

test('YachiyoServer updates an existing provider by id when the name changes', async () => {
  await withServer(async ({ server }) => {
    const provider = await server.upsertProvider({
      id: 'provider-work',
      name: 'work',
      type: 'openai',
      apiKey: 'sk-openai',
      baseUrl: 'https://api.openai.com/v1',
      modelList: {
        enabled: ['gpt-5'],
        disabled: []
      }
    })

    await server.upsertProvider({
      ...provider,
      name: 'work-renamed'
    })

    const config = await server.getConfig()

    assert.equal(config.providers.length, 1)
    assert.equal(config.providers[0]?.id, 'provider-work')
    assert.equal(config.providers[0]?.name, 'work-renamed')
    assert.equal(config.providers[0]?.apiKey, 'sk-openai')
  })
})

test('YachiyoServer persists shared app config changes across tool and layout settings', async () => {
  await withServer(async ({ server, waitForEvent }) => {
    const toolPreferencesUpdated = waitForEvent('settings.updated')
    const toolPreferences = await server.saveToolPreferences({
      enabledTools: ['read', 'edit']
    })

    const toolPreferencesEvent = (await toolPreferencesUpdated) as {
      config: { enabledTools?: string[] }
      settings: { providerName: string }
    }

    assert.deepEqual(toolPreferences.enabledTools, ['read', 'edit'])
    assert.deepEqual(toolPreferencesEvent.config.enabledTools, ['read', 'edit'])
    assert.equal(toolPreferencesEvent.settings.providerName, '')

    const configUpdated = waitForEvent('settings.updated')
    const config = await server.saveConfig({
      ...toolPreferences,
      general: {
        sidebarVisibility: 'collapsed'
      },
      chat: {
        activeRunEnterBehavior: 'enter-queues-follow-up'
      }
    })

    const configEvent = (await configUpdated) as {
      config: {
        enabledTools?: string[]
        general?: { sidebarVisibility?: string }
        chat?: { activeRunEnterBehavior?: string }
      }
    }

    assert.deepEqual(config.enabledTools, ['read', 'edit'])
    assert.equal(config.general?.sidebarVisibility, 'collapsed')
    assert.equal(config.chat?.activeRunEnterBehavior, 'enter-queues-follow-up')
    assert.deepEqual(configEvent.config.enabledTools, ['read', 'edit'])
    assert.equal(configEvent.config.general?.sidebarVisibility, 'collapsed')
    assert.equal(configEvent.config.chat?.activeRunEnterBehavior, 'enter-queues-follow-up')

    const bootstrapped = await server.bootstrap()
    assert.deepEqual(bootstrapped.config.enabledTools, ['read', 'edit'])
    assert.equal(bootstrapped.config.general?.sidebarVisibility, 'collapsed')
    assert.equal(bootstrapped.config.chat?.activeRunEnterBehavior, 'enter-queues-follow-up')
  })
})

test('YachiyoServer preserves tool-model settings when saving the active chat model', async () => {
  await withServer(async ({ server, waitForEvent }) => {
    await server.saveConfig({
      enabledTools: ['read', 'write', 'edit', 'bash', 'webRead'],
      toolModel: {
        mode: 'custom',
        providerId: 'provider-backup',
        providerName: 'backup',
        model: 'claude-haiku-4-5'
      },
      providers: [
        {
          id: 'provider-work',
          name: 'work',
          type: 'openai',
          apiKey: 'sk-openai',
          baseUrl: 'https://api.openai.com/v1',
          modelList: {
            enabled: ['gpt-5'],
            disabled: []
          }
        },
        {
          id: 'provider-backup',
          name: 'backup',
          type: 'anthropic',
          apiKey: 'sk-ant',
          baseUrl: '',
          modelList: {
            enabled: ['claude-haiku-4-5'],
            disabled: []
          }
        }
      ]
    })

    const updatedEvent = waitForEvent('settings.updated')
    await server.saveSettings({
      providerName: 'work',
      model: 'gpt-5'
    })

    const event = (await updatedEvent) as {
      config: {
        toolModel?: {
          mode?: string
          providerId?: string
          providerName?: string
          model?: string
        }
      }
    }

    assert.deepEqual(event.config.toolModel, {
      mode: 'custom',
      providerId: 'provider-backup',
      providerName: 'backup',
      model: 'claude-haiku-4-5'
    })
    assert.deepEqual((await server.getConfig()).toolModel, {
      mode: 'custom',
      providerId: 'provider-backup',
      providerName: 'backup',
      model: 'claude-haiku-4-5'
    })
  })
})

test('YachiyoServer persists thinkingEnabled through saveSettings', async () => {
  await withServer(async ({ server }) => {
    await server.saveConfig({
      enabledTools: ['read', 'write', 'edit', 'bash', 'webRead'],
      defaultModel: {
        providerName: 'work',
        model: 'gpt-5'
      },
      providers: [
        {
          id: 'provider-work',
          name: 'work',
          type: 'openai',
          apiKey: 'sk-openai',
          baseUrl: 'https://api.openai.com/v1',
          thinkingEnabled: true,
          modelList: {
            enabled: ['gpt-5'],
            disabled: []
          }
        }
      ]
    })

    const updated = await server.saveSettings({
      providerName: 'work',
      model: 'gpt-5',
      thinkingEnabled: false
    })

    assert.equal(updated.thinkingEnabled, false)
    assert.equal((await server.getSettings()).thinkingEnabled, false)
    assert.equal((await server.getConfig()).providers[0]?.thinkingEnabled, false)
  })
})

test('YachiyoServer can retry directly from a user request that has no assistant reply yet', async () => {
  let attempt = 0

  await withServer(
    async ({ server, completeRun, waitForEvent }) => {
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
        content: 'Please cancel me halfway.'
      })

      await waitForEvent('message.delta')
      await server.cancelRun({ runId: accepted.runId })
      await completeRun(accepted.runId)

      let bootstrap = await server.bootstrap()
      const [userMessage] = bootstrap.messagesByThread[thread.id] ?? []

      assert.equal(bootstrap.messagesByThread[thread.id]?.length, 2)
      assert.equal(userMessage?.role, 'user')

      const stoppedMessage = (bootstrap.messagesByThread[thread.id] ?? []).find(
        (message) => message.role === 'assistant' && message.status === 'stopped'
      )
      assert.ok(stoppedMessage, 'cancelled run should persist a stopped assistant message')

      const retried = await server.retryMessage({
        threadId: thread.id,
        messageId: userMessage!.id
      })
      await completeRun(retried.runId)

      bootstrap = await server.bootstrap()
      const assistantReply = (bootstrap.messagesByThread[thread.id] ?? []).find(
        (message) =>
          message.parentMessageId === userMessage?.id &&
          message.role === 'assistant' &&
          message.content === 'Hello world'
      )

      assert.equal(retried.requestMessageId, userMessage?.id)
      assert.equal(assistantReply?.content, 'Hello world')
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          if (attempt === 0) {
            attempt += 1
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
      })
    }
  )
})

test('YachiyoServer binds recovered tool calls and closes the harness when retry backoff is cancelled', async () => {
  let attempt = 0

  await withServer(
    async ({ server, completeRun, waitForEvent }) => {
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
        content: 'Retry and then cancel me.'
      })

      const retryingEvent = (await waitForEvent('run.retrying')) as {
        type: 'run.retrying'
        runId: string
      }
      assert.equal(retryingEvent.runId, accepted.runId)

      await server.cancelRun({ runId: accepted.runId })
      const harnessFinished = (await waitForEvent('harness.finished')) as {
        type: 'harness.finished'
        status: string
      }
      assert.equal(harnessFinished.status, 'cancelled')
      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const stoppedMessage = (bootstrap.messagesByThread[thread.id] ?? []).find(
        (message) => message.role === 'assistant' && message.status === 'stopped'
      )
      const toolCall = (bootstrap.toolCallsByThread[thread.id] ?? [])[0]

      assert.ok(stoppedMessage)
      assert.equal(toolCall?.status, 'completed')
      assert.equal(toolCall?.assistantMessageId, stoppedMessage?.id)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest): AsyncIterable<string> {
          attempt += 1

          if (attempt === 1) {
            request.onToolCallStart?.({
              abortSignal: request.signal,
              experimental_context: undefined,
              functionId: undefined,
              messages: request.messages,
              metadata: undefined,
              model: undefined,
              stepNumber: 0,
              toolCall: {
                input: { path: 'notes.txt' },
                toolCallId: 'tool-retry-cancel-1',
                toolName: 'read'
              }
            } as never)
            request.onToolCallFinish?.({
              abortSignal: request.signal,
              durationMs: 1,
              experimental_context: undefined,
              functionId: undefined,
              messages: request.messages,
              metadata: undefined,
              model: undefined,
              stepNumber: 0,
              success: true,
              output: {
                content: [{ type: 'text', text: 'partial' }],
                details: {
                  endLine: 1,
                  path: '/tmp/notes.txt',
                  startLine: 1,
                  totalBytes: 7,
                  totalLines: 1,
                  truncated: false
                },
                metadata: {}
              },
              toolCall: {
                input: { path: 'notes.txt' },
                toolCallId: 'tool-retry-cancel-1',
                toolName: 'read'
              }
            } as never)

            yield 'Partial answer'
            throw Object.assign(new Error('temporary upstream failure'), { status: 500 })
          }

          yield 'Recovered answer'
        }
      })
    }
  )
})

test('YachiyoServer points the thread head at the retried request immediately', async () => {
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
        content: 'First question'
      })
      await completeRun(accepted.runId)

      let bootstrap = await server.bootstrap()
      const [userMessage, assistantMessage] = bootstrap.messagesByThread[thread.id] ?? []

      assert.equal(bootstrap.threads[0]?.headMessageId, assistantMessage?.id)

      const retried = await server.retryMessage({
        threadId: thread.id,
        messageId: assistantMessage!.id
      })

      bootstrap = await server.bootstrap()
      assert.equal(retried.requestMessageId, userMessage?.id)
      assert.equal(bootstrap.threads[0]?.headMessageId, userMessage?.id)

      await completeRun(retried.runId)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(): AsyncIterable<string> {
          attempt += 1

          if (attempt === 1) {
            yield 'First answer'
            return
          }

          await new Promise((resolve) => setTimeout(resolve, 10))
          yield 'Retried answer'
        }
      })
    }
  )
})

test('YachiyoServer compacts a thread into a new assistant-first thread and allows normal continuation', async () => {
  const requests: ModelStreamRequest[] = []

  await withServer(
    async ({ server, completeRun }) => {
      const sourceThread = await server.createThread()
      const sourceAccepted = await server.sendChat({
        threadId: sourceThread.id,
        content: 'We decided to ship the desktop update on Friday.'
      })
      await completeRun(sourceAccepted.runId)

      const compacted = await server.compactThreadToAnotherThread({
        threadId: sourceThread.id
      })
      await completeRun(compacted.runId)

      let bootstrap = await server.bootstrap()
      const persistedSourceThread = bootstrap.threads.find(
        (thread) => thread.id === sourceThread.id
      )
      const destinationMessages = bootstrap.messagesByThread[compacted.thread.id] ?? []

      assert.equal(destinationMessages.length, 1)
      assert.equal(destinationMessages[0]?.role, 'assistant')
      assert.equal(destinationMessages[0]?.parentMessageId, undefined)
      assert.equal(destinationMessages[0]?.content, 'Visible handoff')
      assert.notEqual(compacted.thread.title, persistedSourceThread?.title)
      assert.equal(
        bootstrap.threads.some((thread) => thread.id === compacted.thread.id),
        true
      )
      assert.equal(
        bootstrap.threads.some((thread) => thread.id === sourceThread.id),
        true
      )
      assert.equal(
        bootstrap.threads.find((thread) => thread.id === compacted.thread.id)?.title,
        persistedSourceThread?.title
      )

      const handoffRequest = requests.at(-1)
      assert.ok(handoffRequest)
      assert.equal(handoffRequest.tools, undefined)
      assert.equal(handoffRequest.messages.at(-1)?.role, 'user')
      assert.match(String(handoffRequest.messages.at(-1)?.content), /visible handoff/i)
      assert.equal(
        handoffRequest.messages.some(
          (message) =>
            message.role === 'user' &&
            message.content === 'We decided to ship the desktop update on Friday.'
        ),
        true
      )
      assert.equal(
        handoffRequest.messages.some(
          (message) => message.role === 'assistant' && message.content === 'Hello world'
        ),
        true
      )

      const continuation = await server.sendChat({
        threadId: compacted.thread.id,
        content: 'Continue from that handoff.'
      })
      await completeRun(continuation.runId)

      bootstrap = await server.bootstrap()
      const continuedMessages = bootstrap.messagesByThread[compacted.thread.id] ?? []
      const continuationUser = continuedMessages.find(
        (message) => message.role === 'user' && message.content === 'Continue from that handoff.'
      )
      const continuationAssistant = continuedMessages.find(
        (message) =>
          message.role === 'assistant' &&
          message.parentMessageId === continuationUser?.id &&
          message.id !== destinationMessages[0]?.id
      )

      assert.equal(continuedMessages[0]?.id, destinationMessages[0]?.id)
      assert.equal(continuationUser?.parentMessageId, destinationMessages[0]?.id)
      assert.equal(continuationAssistant?.content, 'Hello world')
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          const lastMessage = request.messages.at(-1)
          const lastMessageText =
            typeof lastMessage?.content === 'string' ? lastMessage.content : ''

          if (/visible handoff/i.test(lastMessageText)) {
            yield 'Visible'
            yield ' handoff'
            return
          }

          yield 'Hello'
          yield ' world'
        }
      })
    }
  )
})

test('YachiyoServer allows changing a fresh handoff thread workspace before the first user continuation', async () => {
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

      const inheritedWorkspace = join(tmpdir(), 'yachiyo-handoff-inherited-workspace')
      const sourceThread = await server.createThread({
        workspacePath: inheritedWorkspace
      })
      const sourceAccepted = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Prepare a handoff.'
      })
      await completeRun(sourceAccepted.runId)

      const compacted = await server.compactThreadToAnotherThread({
        threadId: sourceThread.id
      })
      await completeRun(compacted.runId)

      const replacementWorkspace = join(tmpdir(), 'yachiyo-handoff-replacement-workspace')
      const updatedThread = await server.updateThreadWorkspace({
        threadId: compacted.thread.id,
        workspacePath: replacementWorkspace
      })
      assert.equal(updatedThread.workspacePath, replacementWorkspace)

      const continuation = await server.sendChat({
        threadId: compacted.thread.id,
        content: 'Continue from the handoff.'
      })
      await completeRun(continuation.runId)

      await assert.rejects(
        server.updateThreadWorkspace({
          threadId: compacted.thread.id,
          workspacePath: inheritedWorkspace
        }),
        /before the first message is sent/
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest): AsyncIterable<string> {
          const lastMessage = request.messages.at(-1)
          const lastMessageText =
            typeof lastMessage?.content === 'string' ? lastMessage.content : ''

          if (/visible handoff/i.test(lastMessageText)) {
            yield 'Visible handoff'
            return
          }

          yield 'Hello world'
        }
      })
    }
  )
})

test('YachiyoServer blocks compact-to-another-thread while the source thread is running', async () => {
  await withServer(async ({ server }) => {
    const thread = await server.createThread()
    await server.sendChat({
      threadId: thread.id,
      content: 'Keep working on this for a moment.'
    })

    await assert.rejects(
      () =>
        server.compactThreadToAnotherThread({
          threadId: thread.id
        }),
      /Cannot compact a thread with an active run\./
    )

    const bootstrap = await server.bootstrap()
    assert.equal(bootstrap.threads.length, 1)
    assert.equal(bootstrap.threads[0]?.id, thread.id)
  })
})

test('YachiyoServer rejects rolling compaction for local threads', async () => {
  await withServer(async ({ server }) => {
    const thread = await server.createThread()

    await assert.rejects(
      () =>
        server.compactExternalThread({
          threadId: thread.id
        }),
      /only supported for external channel threads/i
    )
  })
})

test('YachiyoServer rolls up external DM threads in place', async () => {
  const requests: ModelStreamRequest[] = []

  await withServer(
    async ({ server, completeRun }) => {
      const thread = await server.createThread({
        source: 'telegram',
        channelUserId: 'tg-user-1',
        title: 'Telegram:@alice'
      })
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Keep the DM going.'
      })
      await completeRun(accepted.runId)

      const compacted = await server.compactExternalThread({
        threadId: thread.id
      })

      assert.equal(compacted.thread.id, thread.id)
      assert.equal(compacted.thread.rollingSummary, 'External summary')
      assert.ok(compacted.thread.summaryWatermarkMessageId)

      const persisted = server.listExternalThreads().find((entry) => entry.id === thread.id)
      assert.equal(persisted?.rollingSummary, 'External summary')
      assert.equal(persisted?.summaryWatermarkMessageId, compacted.thread.summaryWatermarkMessageId)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest): AsyncIterable<string> {
          requests.push(request)

          const lastMessage = request.messages.at(-1)
          const lastMessageText =
            typeof lastMessage?.content === 'string' ? lastMessage.content : ''

          if (lastMessageText.includes('Write a continuation summary')) {
            yield 'External summary'
            return
          }

          yield 'Visible reply'
        }
      })
    }
  )

  assert.equal(
    requests.some((request) =>
      request.messages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('Write a continuation summary')
      )
    ),
    true
  )
})

test('YachiyoServer does not create a destination thread when compact workspace cloning fails', async () => {
  await withServer(
    async ({ server, completeRun }) => {
      const sourceThread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Keep this thread intact if compact setup fails.'
      })
      await completeRun(accepted.runId)

      await assert.rejects(
        () =>
          server.compactThreadToAnotherThread({
            threadId: sourceThread.id
          }),
        /workspace clone failed/
      )

      const bootstrap = await server.bootstrap()
      assert.equal(bootstrap.threads.length, 1)
      assert.equal(bootstrap.threads[0]?.id, sourceThread.id)
    },
    {
      cloneThreadWorkspace: async () => {
        throw new Error('workspace clone failed')
      }
    }
  )
})

test('YachiyoServer bootstrap creates the default USER.md template under the same .yachiyo root', async () => {
  await withServer(async ({ server }) => {
    await server.bootstrap()

    const document = await server.getUserDocument()
    const content = await readFile(document.filePath, 'utf8')

    assert.equal(document.filePath.includes('/.yachiyo/USER.md'), true)
    assert.match(content, /^# USER/m)
    assert.match(content, /durable understanding of the user/)
  })
})

test('YachiyoServer persists direct USER.md edits through the settings-facing API', async () => {
  await withServer(async ({ server }) => {
    const saved = await server.saveUserDocument({
      content: '# USER\n\n## Preferences\n- Prefers concise collaboration'
    })

    assert.equal(saved.filePath.includes('/.yachiyo/USER.md'), true)
    // saveUserDocument writes raw content; getUserDocument may migrate freeform to tables
    const onDisk = await readFile(saved.filePath, 'utf8')
    assert.match(onDisk, /# USER/)
    assert.match(onDisk, /Preferences/)
    assert.match(onDisk, /concise collaboration/)
  })
})

test('YachiyoServer injects USER.md as a separate context layer and exposes the model edit path', async () => {
  await withServer(
    async ({ server, completeRun, modelRequests }) => {
      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Use the saved profile.'
      })

      await completeRun(accepted.runId)

      const request = modelRequests.at(-1)
      assert.ok(request)

      const systemMessages = request.messages.filter((message) => message.role === 'system')
      assert.equal(
        systemMessages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('durable understanding of the user from USER.md')
        ),
        true
      )
      assert.equal(
        systemMessages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('Do not mix USER.md content into SOUL.md.')
        ),
        true
      )
      assert.equal(
        systemMessages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('# USER') &&
            message.content.includes('Leader prefers direct tradeoff summaries')
        ),
        true
      )
      assert.equal(
        systemMessages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('Responds with stable optimism')
        ),
        true
      )
      assert.equal(
        systemMessages.some(
          (message) =>
            typeof message.content === 'string' &&
            message.content.includes('Leader prefers direct tradeoff summaries') &&
            message.content.includes('from SOUL.md')
        ),
        false
      )
    },
    {
      readSoulDocument: async () => ({
        filePath: '/tmp/.yachiyo/SOUL.md',
        rawContent:
          '# SOUL\n\n## Evolved Traits\n### 2026-03-22\n- Responds with stable optimism\n',
        evolvedTraits: ['Responds with stable optimism'],
        lastUpdated: '2026-03-22T00:00:00.000Z'
      }),
      readUserDocument: async () => ({
        filePath: '/tmp/.yachiyo/USER.md',
        content: '# USER\n\n## Preferences\n- Leader prefers direct tradeoff summaries\n'
      })
    }
  )
})

test('YachiyoServer.editMessage rejects empty content before mutating history', async () => {
  await withServer(async ({ server, completeRun }) => {
    await server.upsertProvider({
      name: 'work',
      type: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      modelList: { enabled: ['gpt-5'], disabled: [] }
    })

    const thread = await server.createThread()
    const accepted = await server.sendChat({ threadId: thread.id, content: 'Original message' })
    assertAcceptedHasUserMessage(accepted)
    await completeRun(accepted.runId)

    const messageCountBefore = (await server.bootstrap()).messagesByThread[thread.id]?.length ?? 0

    await assert.rejects(
      () =>
        server.editMessage({
          threadId: thread.id,
          messageId: accepted.userMessage.id,
          content: '   '
        }),
      /Cannot send an empty message/
    )

    // History must be intact — no messages should have been deleted
    const messageCountAfter = (await server.bootstrap()).messagesByThread[thread.id]?.length ?? 0
    assert.equal(messageCountAfter, messageCountBefore)
  })
})

test('YachiyoServer.editMessage replaces the user message and dependent history then starts a new run', async () => {
  await withServer(async ({ server, completeRun }) => {
    await server.upsertProvider({
      name: 'work',
      type: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      modelList: { enabled: ['gpt-5'], disabled: [] }
    })

    const thread = await server.createThread()
    const firstAccepted = await server.sendChat({ threadId: thread.id, content: 'First question' })
    assertAcceptedHasUserMessage(firstAccepted)
    const originalUserMessageId = firstAccepted.userMessage.id
    await completeRun(firstAccepted.runId)

    const beforeEdit = await server.bootstrap()
    assert.equal(beforeEdit.messagesByThread[thread.id]?.length, 2)

    const editAccepted = await server.editMessage({
      threadId: thread.id,
      messageId: originalUserMessageId,
      content: 'Revised question'
    })
    assertAcceptedHasUserMessage(editAccepted)
    assert.equal(editAccepted.kind, 'run-started')
    assert.equal(editAccepted.userMessage.content, 'Revised question')
    assert.equal(editAccepted.replacedMessageId, originalUserMessageId)

    await completeRun(editAccepted.runId)

    const afterEdit = await server.bootstrap()
    const messages = afterEdit.messagesByThread[thread.id] ?? []
    assert.equal(messages.length, 2)
    assert.equal(messages[0]?.role, 'user')
    assert.equal(messages[0]?.content, 'Revised question')
    assert.equal(messages[1]?.role, 'assistant')
    assert.ok(messages.every((m) => m.id !== originalUserMessageId))
  })
})

test('YachiyoServer.editMessage throws when the thread has an active run', async () => {
  let releaseRun: (() => void) | null = null
  const runGate = new Promise<void>((resolve) => {
    releaseRun = resolve
  })

  await withServer(
    async ({ server, completeRun }) => {
      await server.upsertProvider({
        name: 'work',
        type: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        modelList: { enabled: ['gpt-5'], disabled: [] }
      })

      const thread = await server.createThread()
      const accepted = await server.sendChat({ threadId: thread.id, content: 'Ongoing message' })
      assertAcceptedHasUserMessage(accepted)

      await assert.rejects(
        () =>
          server.editMessage({
            threadId: thread.id,
            messageId: accepted.userMessage.id,
            content: 'Attempted edit during active run'
          }),
        /Cannot edit history while this thread is running/
      )

      releaseRun?.()
      await completeRun(accepted.runId)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(): AsyncIterable<string> {
          await runGate
          yield 'Hello'
          yield ' world'
        }
      })
    }
  )
})

test('YachiyoServer.createBranch inherits icon and title from parent thread', async () => {
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
      await server.setThreadIcon({ threadId: thread.id, icon: '🌊' })
      await server.renameThread({ threadId: thread.id, title: 'Ocean Thoughts' })

      const accepted = await server.sendChat({ threadId: thread.id, content: 'Hello' })
      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const assistantMessage = bootstrap.messagesByThread[thread.id]?.[1]

      const branch = await server.createBranch({
        threadId: thread.id,
        messageId: assistantMessage!.id
      })

      assert.equal(branch.thread.icon, '🌊', 'branch should inherit parent icon')
      assert.equal(branch.thread.title, 'Ocean Thoughts', 'branch should inherit parent title')
    },
    {
      createModelRuntime: () => ({
        async *streamReply(): AsyncIterable<string> {
          yield 'Reply'
        }
      })
    }
  )
})
