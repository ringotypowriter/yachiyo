import assert from 'node:assert/strict'
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { YachiyoServer } from '../YachiyoServer.ts'
import type { ModelStreamRequest } from '../../../runtime/types.ts'
import type { SoulDocument } from '../../../runtime/soul.ts'
import { readUserDocument, writeUserDocument } from '../../../runtime/user.ts'
import { createInMemoryYachiyoStorage } from '../../../storage/memoryStorage.ts'
import type { MemoryService } from '../../../services/memory/memoryService.ts'
import type {
  ChatAccepted,
  ChatAcceptedWithUserMessage,
  UserDocument,
  YachiyoServerEvent
} from '../../../../../shared/yachiyo/protocol.ts'

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
      for (const expected of ['askUser', 'read', 'updateProfile']) {
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
      for (const expected of ['askUser', 'bash', 'updateProfile']) {
        assert.ok(
          resumedRequests[0]?.toolNames?.includes(expected),
          `run 0 should include ${expected}`
        )
      }
      assert.match(String(resumedRequests[1]?.content ?? ''), /Recovered queued follow-up/)
      for (const expected of ['askUser', 'read', 'updateProfile']) {
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
