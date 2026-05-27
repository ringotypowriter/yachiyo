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
import { withThreadCapabilities } from '@yachiyo/shared/protocol'

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
