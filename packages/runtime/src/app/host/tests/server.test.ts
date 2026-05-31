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
import {
  type ChatAccepted,
  type ChatAcceptedWithUserMessage,
  type ThreadUpdatedEvent,
  type UserDocument,
  type YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import { getThreadPlanDocumentFilename, PLAN_DOCUMENT_MARKER } from '@yachiyo/shared/planMode'
import { RUN_MODE_DEFINITIONS } from '@yachiyo/shared/toolModes'

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
    resolveThreadWorkspacePath: workspacePathForThread,
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
        // Verify the user's message text is embedded in the title-gen prompt.
        // Avoid asserting on exact prompt wording — only check the query made it through.
        assert.match(
          typeof auxiliaryRequest?.messages[0]?.content === 'string'
            ? auxiliaryRequest.messages[0].content
            : '',
          /Plan the MVP/u
        )
      } finally {
        releaseMainRun?.()
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

test('YachiyoServer refines owner DM thread titles like local threads', async () => {
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

      const owner = server.createChannelUser({
        id: 'tg-owner-title',
        platform: 'telegram',
        externalUserId: '123',
        username: 'owner',
        label: '',
        status: 'allowed',
        role: 'owner',
        usageLimitKTokens: null,
        workspacePath: '/tmp/tg-owner-title'
      })
      const thread = await server.createThread({
        source: 'telegram',
        channelUserId: owner.id
      })
      const waiter = createServerEventWaiter(server)

      try {
        const titleUpdatedEvent = waiter.waitForEvent(
          'thread.updated',
          (event) => event.threadId === thread.id && event.thread.title === 'Owner DM launch plan'
        )

        const accepted = await server.sendChat({
          threadId: thread.id,
          content: 'Plan the owner DM launch'
        })

        const titleUpdate = await Promise.race([
          titleUpdatedEvent,
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Timed out waiting for owner DM title update')), 1000)
          })
        ])

        releaseMainRun?.()
        await completeRun(accepted.runId)
        const bootstrap = await server.bootstrap()
        const ownerThread = bootstrap.threads.find((candidate) => candidate.id === thread.id)
        const auxiliaryRequest = requests.find(
          (request) => request.providerOptionsMode === 'auxiliary'
        )

        assert.equal(titleUpdate.thread.title, 'Owner DM launch plan')
        assert.equal(ownerThread?.title, 'Owner DM launch plan')
        assert.equal(requests.length, 2)
        assert.equal(auxiliaryRequest?.settings.model, 'gpt-5-mini')
        assert.match(
          typeof auxiliaryRequest?.messages[0]?.content === 'string'
            ? auxiliaryRequest.messages[0].content
            : '',
          /Plan the owner DM launch/u
        )
      } finally {
        releaseMainRun?.()
        waiter.close()
      }
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (request.providerOptionsMode === 'auxiliary') {
            yield 'Owner DM launch plan'
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

test('YachiyoServer exposes owner DM threads through the normal bootstrap list', async () => {
  await withServer(async ({ server }) => {
    const owner = server.createChannelUser({
      id: 'tg-owner-normal-thread',
      platform: 'telegram',
      externalUserId: 'owner-123',
      username: 'owner',
      label: '',
      status: 'allowed',
      role: 'owner',
      usageLimitKTokens: null,
      workspacePath: '/tmp/tg-owner-normal-thread'
    })
    const guest = server.createChannelUser({
      id: 'tg-guest-external-thread',
      platform: 'telegram',
      externalUserId: 'guest-456',
      username: 'guest',
      label: '',
      status: 'allowed',
      role: 'guest',
      usageLimitKTokens: null,
      workspacePath: '/tmp/tg-guest-external-thread'
    })

    const ownerThread = await server.createThread({
      source: 'telegram',
      channelUserId: owner.id
    })
    const guestThread = await server.createThread({
      source: 'telegram',
      channelUserId: guest.id,
      title: 'Telegram:@guest'
    })

    const bootstrap = await server.bootstrap()
    const normalThreadIds = bootstrap.threads.map((thread) => thread.id)
    const externalThreadIds = server.listExternalThreads().map((thread) => thread.id)

    assert.equal(ownerThread.channelUserRole, 'owner')
    assert.equal(guestThread.channelUserRole, 'guest')
    assert.deepEqual(normalThreadIds, [ownerThread.id])
    assert.equal(
      bootstrap.threads.find((thread) => thread.id === ownerThread.id)?.channelUserRole,
      'owner'
    )
    assert.deepEqual(externalThreadIds, [guestThread.id])
  })
})

test('YachiyoServer reuses implicit owner DM workspace when creating a handoff thread', async () => {
  await withServer(async ({ server, workspacePathForThread }) => {
    const owner = server.createChannelUser({
      id: 'tg-owner-handoff-workspace',
      platform: 'telegram',
      externalUserId: 'owner-implicit-workspace',
      username: 'owner',
      label: '',
      status: 'allowed',
      role: 'owner',
      usageLimitKTokens: null,
      workspacePath: '/tmp/tg-owner-handoff-workspace'
    })
    const sourceThread = await server.createThread({
      source: 'telegram',
      channelUserId: owner.id
    })
    const handoffThread = await server.createThread({
      source: 'telegram',
      channelUserId: owner.id,
      handoffFromThreadId: sourceThread.id
    })

    assert.equal(handoffThread.workspacePath, workspacePathForThread(sourceThread.id))
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
            message.content.includes('<memory>\n') &&
            message.content.includes(
              '- Deploy workflow: Always run the staging smoke test first.\n</memory>'
            )
        )
      )
    },
    {
      memoryService: {
        hasHiddenSearchCapability: () => true,
        isConfigured: () => true,
        searchMemories: async () => [],
        recallForContext: async ({ thread, userQuery }) => {
          recalledQueries.push(userQuery)
          return {
            decision: {
              shouldRecall: true,
              score: 1,
              reasons: ['topic-novelty'],
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

test('YachiyoServer skips automatic memory recall when disabled', async () => {
  let recallCalls = 0

  await withServer(
    async ({ completeRun, modelRequests, server, waitForEvent }) => {
      const config = await server.getConfig()
      await server.saveConfig({
        ...config,
        memory: {
          ...config.memory,
          autoRecall: false
        }
      })

      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'How do we handle deploys?'
      })
      assertAcceptedHasUserMessage(accepted)
      const recalledEvent = (await waitForEvent('run.memory.recalled')) as {
        recalledMemoryEntries: string[]
      }
      await completeRun(accepted.runId)

      const mainRequest = modelRequests.find(
        (request) => request.providerOptionsMode !== 'auxiliary'
      )
      assert.ok(mainRequest)
      assert.equal(recallCalls, 0)
      assert.deepEqual(recalledEvent.recalledMemoryEntries, [])
      assert.equal(
        mainRequest.messages.some(
          (message) => typeof message.content === 'string' && message.content.includes('<memory>')
        ),
        false
      )
    },
    {
      memoryService: {
        hasHiddenSearchCapability: () => true,
        isConfigured: () => true,
        searchMemories: async () => [],
        recallForContext: async ({ thread }) => {
          recallCalls++
          return {
            decision: {
              shouldRecall: true,
              score: 1,
              reasons: ['topic-novelty'],
              messagesSinceLastRecall: 1,
              charsSinceLastRecall: 24,
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

test('YachiyoServer.acceptThreadPlanDocument runs directly in the source thread when requested', async () => {
  await withServer(
    async ({ server, storage, completeRun, modelRequests, workspacePathForThread }) => {
      const sourceThread = await server.createThread()
      const priorAccepted = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Draft a blog generator architecture first.'
      })
      assertAcceptedHasUserMessage(priorAccepted)
      await completeRun(priorAccepted.runId)

      const priorMessages = storage.listThreadMessages(sourceThread.id)
      const priorAssistantMessage = priorMessages.find(
        (message) => message.role === 'assistant' && message.content === 'Hello world'
      )
      assert.ok(priorAssistantMessage)

      const workspacePath = workspacePathForThread(sourceThread.id)
      await mkdir(join(workspacePath, '.yachiyo'), { recursive: true })

      const planFilename = getThreadPlanDocumentFilename(sourceThread.id)
      const planPath = join(workspacePath, '.yachiyo', planFilename)

      const planContent = ['# Build Blog Generator', '', '## Goal', 'Ship it.', ''].join('\n')
      await writeFile(planPath, planContent, 'utf8')

      const accepted = await server.acceptThreadPlanDocument({
        threadId: sourceThread.id,
        mode: 'direct'
      })
      assertAcceptedHasUserMessage(accepted)

      const sourceMessages = storage.listThreadMessages(sourceThread.id)
      const planMessage = sourceMessages.find(
        (message) =>
          message.role === 'assistant' && message.content.startsWith(PLAN_DOCUMENT_MARKER)
      )
      assert.ok(planMessage)
      assert.ok(planMessage.content.includes(planContent))
      assert.notEqual(planMessage.hidden, true)
      assert.equal(planMessage.parentMessageId, priorAssistantMessage.id)

      const handoffThreads = storage
        .bootstrap()
        .threads.filter((thread) => thread.handoffFromThreadId === sourceThread.id)

      assert.equal(handoffThreads.length, 0)
      assert.equal(accepted.thread.id, sourceThread.id)
      assert.equal(accepted.thread.handoffFromThreadId, undefined)
      assert.equal(accepted.thread.runMode, 'auto')
      assert.equal(accepted.userMessage.threadId, sourceThread.id)
      assert.equal(accepted.userMessage.parentMessageId, planMessage.id)
      assert.notEqual(accepted.userMessage.hidden, true)
      assert.equal(accepted.userMessage.content, 'Execute the accepted plan.')

      await completeRun(accepted.runId)

      const executionRequest = modelRequests.at(-1)
      assert.ok(executionRequest)
      const executionContextText = executionRequest.messages
        .map((message) =>
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
        )
        .join('\n')
      assert.ok(executionContextText.includes('Draft a blog generator architecture first.'))
      assert.ok(executionContextText.includes('Hello world'))
      assert.ok(executionContextText.includes(planContent))
      assert.ok(executionContextText.includes('Execute the accepted plan.'))

      const updatedSourceThread = storage
        .bootstrap()
        .threads.find((thread) => thread.id === sourceThread.id)
      assert.equal(updatedSourceThread?.runMode, 'auto')
    }
  )
})

test('YachiyoServer.acceptThreadPlanDocument tells direct execution the accepted plan is now Auto Mode', async () => {
  await withServer(
    async ({ server, storage, completeRun, modelRequests, workspacePathForThread }) => {
      const sourceThread = await server.createThread()
      await server.setThreadToolMode({
        threadId: sourceThread.id,
        enabledTools: [...RUN_MODE_DEFINITIONS.plan.enabledTools]
      })
      const planRun = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Draft a blog generator architecture first.',
        runMode: 'plan'
      })
      assertAcceptedHasUserMessage(planRun)
      await completeRun(planRun.runId)

      const unrelatedThread = await server.createThread()
      const unrelatedRun = await server.sendChat({
        threadId: unrelatedThread.id,
        content: 'Unrelated auto work.',
        runMode: 'auto'
      })
      assertAcceptedHasUserMessage(unrelatedRun)
      await completeRun(unrelatedRun.runId)

      const workspacePath = workspacePathForThread(sourceThread.id)
      await mkdir(join(workspacePath, '.yachiyo'), { recursive: true })
      const planPath = join(
        workspacePath,
        '.yachiyo',
        getThreadPlanDocumentFilename(sourceThread.id)
      )
      await writeFile(planPath, '# Build Blog Generator\n\n## Goal\nShip it.\n', 'utf8')

      const accepted = await server.acceptThreadPlanDocument({
        threadId: sourceThread.id,
        mode: 'direct'
      })
      assertAcceptedHasUserMessage(accepted)
      await completeRun(accepted.runId)

      const sourceMessages = storage.listThreadMessages(sourceThread.id)
      const planRequest = sourceMessages.find(
        (message) => message.role === 'user' && message.content === planRun.userMessage.content
      )
      assert.ok(planRequest?.turnContext?.reminder?.includes('Plan Mode'))

      const executionRequest = modelRequests.at(-1)
      assert.ok(executionRequest)
      const executionContextText = executionRequest.messages
        .map((message) =>
          typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
        )
        .join('\n')
      assert.ok(executionContextText.includes('Plan Mode'))
      assert.ok(executionContextText.includes('Mode changed to Auto Mode for this turn'))
      assert.ok(executionContextText.includes('Enabled tools:'))
      assert.ok(executionContextText.includes('Disabled tools:'))
    }
  )
})

test('YachiyoServer.acceptThreadPlanDocument creates an execution thread seeded with the plan document', async () => {
  await withServer(async ({ server, storage, completeRun, workspacePathForThread }) => {
    const sourceThread = await server.createThread()
    const threadUpdatedEvents: ThreadUpdatedEvent[] = []
    const unsubscribe = server.subscribe((event) => {
      if (event.type === 'thread.updated') threadUpdatedEvents.push(event)
    })
    const sourceThreadWithIcon = await server.setThreadIcon({
      threadId: sourceThread.id,
      icon: '🧪'
    })

    const workspacePath = workspacePathForThread(sourceThread.id)
    await mkdir(join(workspacePath, '.yachiyo'), { recursive: true })

    const planFilename = getThreadPlanDocumentFilename(sourceThread.id)
    const planPath = join(workspacePath, '.yachiyo', planFilename)

    const planContent = ['# Build Blog Generator', '', '## Goal', 'Ship it.', ''].join('\n')
    await writeFile(planPath, planContent, 'utf8')

    const accepted = await (async () => {
      try {
        return await server.acceptThreadPlanDocument({
          threadId: sourceThread.id,
          mode: 'handoff'
        })
      } finally {
        unsubscribe()
      }
    })()
    assertAcceptedHasUserMessage(accepted)

    await completeRun(accepted.runId)

    const destinationMessages = storage.listThreadMessages(accepted.thread.id)
    const planMessage = destinationMessages.find(
      (message) => message.role === 'assistant' && message.content.startsWith(PLAN_DOCUMENT_MARKER)
    )
    assert.ok(planMessage)
    assert.ok(planMessage.content.includes(planContent))

    assert.equal(accepted.thread.handoffFromThreadId, sourceThread.id)
    assert.equal(accepted.thread.workspacePath, workspacePath)
    assert.equal(accepted.thread.title, 'Build Blog Generator')
    assert.equal(accepted.thread.icon, sourceThreadWithIcon.icon)
    assert.equal(accepted.thread.runMode, 'auto')
    assert.equal(accepted.userMessage.parentMessageId, planMessage.id)
    assert.notEqual(accepted.userMessage.hidden, true)
    assert.equal(accepted.userMessage.content, 'Execute the accepted plan.')

    const updatedSourceThread = storage.getThread(sourceThread.id)
    const updatedDestinationThread = storage.getThread(accepted.thread.id)
    assert.ok(updatedSourceThread)
    assert.ok(updatedDestinationThread)
    assert.ok(updatedDestinationThread.folderId)
    assert.equal(accepted.thread.folderId, updatedDestinationThread.folderId)
    assert.equal(updatedSourceThread.preview, 'Plan has been approved')
    assert.equal(updatedSourceThread.folderId, updatedDestinationThread.folderId)

    const sourcePreviewEvent = threadUpdatedEvents.findLast(
      (event) =>
        event.threadId === sourceThread.id && event.thread.preview === 'Plan has been approved'
    )
    assert.ok(sourcePreviewEvent)
    assert.equal(sourcePreviewEvent.thread.folderId, updatedDestinationThread.folderId)
  })
})

test('YachiyoServer.acceptThreadPlanDocument returns the existing handoff for concurrent accepts', async () => {
  await withServer(async ({ server, storage, workspacePathForThread }) => {
    const sourceThread = await server.createThread()
    const workspacePath = workspacePathForThread(sourceThread.id)
    await mkdir(join(workspacePath, '.yachiyo'), { recursive: true })

    const planFilename = getThreadPlanDocumentFilename(sourceThread.id)
    await writeFile(join(workspacePath, '.yachiyo', planFilename), '# Execution Plan\n', 'utf8')

    const [firstAccepted, secondAccepted] = await Promise.all([
      server.acceptThreadPlanDocument({ threadId: sourceThread.id, mode: 'handoff' }),
      server.acceptThreadPlanDocument({ threadId: sourceThread.id, mode: 'handoff' })
    ])
    assertAcceptedHasUserMessage(firstAccepted)
    assertAcceptedHasUserMessage(secondAccepted)

    const destinationThreads = storage
      .bootstrap()
      .threads.filter((thread) => thread.handoffFromThreadId === sourceThread.id)

    assert.equal(destinationThreads.length, 1)
    assert.equal(secondAccepted.thread.id, firstAccepted.thread.id)
    assert.equal(secondAccepted.runId, firstAccepted.runId)
    assert.equal(secondAccepted.userMessage.id, firstAccepted.userMessage.id)
  })
})
