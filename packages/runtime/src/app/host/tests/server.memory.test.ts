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
  UserDocument
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
        recallForContext: async ({ history, thread }) => {
          recalledHistoryIds.push(history.map((message) => message.id))
          return {
            decision: {
              shouldRecall: true,
              score: 1,
              reasons: ['topic-novelty'],
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

test('YachiyoServer injects querySource for durable source queries', async () => {
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
  assert.equal('querySource' in (configuredMainRequest?.tools ?? {}), true)
  assert.equal('querySource' in (disabledMainRequest?.tools ?? {}), true)
})

test('YachiyoServer does not claim there are no tools when querySource is the only source tool', async () => {
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
  assert.equal('querySource' in (mainRequest?.tools ?? {}), true)
  assert.equal(
    systemMessages.some((message) => /No tools are available for this run/u.test(message.content)),
    false
  )
  assert.equal(
    systemMessages.some((message) => /querySource is available internally/u.test(message.content)),
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
        recallForContext: async () => {
          throw new Error('Cannot connect to memory')
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
