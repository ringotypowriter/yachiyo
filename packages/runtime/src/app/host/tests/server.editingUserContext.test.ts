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

test('YachiyoServer injects USER.md into the consolidated system layer and exposes the model edit path', async () => {
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
      // With consolidated system messages, verify that user content appears
      // under the user preamble section, not inline with the soul preamble.
      const consolidated = systemMessages.find(
        (message) =>
          typeof message.content === 'string' &&
          message.content.includes('Leader prefers direct tradeoff summaries')
      )
      assert.ok(consolidated)
      const text = consolidated!.content as string
      const userHeaderIdx = text.indexOf('# USER')
      const soulHeaderIdx = text.indexOf('# SOUL')
      const userContentIdx = text.indexOf('Leader prefers direct tradeoff summaries')
      assert.ok(
        userContentIdx > userHeaderIdx,
        'user content should follow the USER document header'
      )
      assert.ok(
        userContentIdx > soulHeaderIdx,
        'user content should not appear before the SOUL document section'
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

test('YachiyoServer.editMessage forwards an explicit run mode', async () => {
  await withServer(async ({ server, completeRun, storage }) => {
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
    await completeRun(firstAccepted.runId)

    const editAccepted = await server.editMessage({
      threadId: thread.id,
      messageId: firstAccepted.userMessage.id,
      content: 'Revised question',
      enabledTools: ['bash'],
      runMode: 'chat'
    })
    assertAcceptedHasUserMessage(editAccepted)

    await completeRun(editAccepted.runId)

    const editedUserMessage = storage.listThreadMessages(thread.id).find((message) => {
      return message.id === editAccepted.userMessage.id
    })
    assert.equal(editedUserMessage?.turnContext?.runMode, 'chat')
    assert.deepEqual(editedUserMessage?.turnContext?.enabledTools, [])
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

test('YachiyoServer.createBranch inherits icon and model while renaming the title', async () => {
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
      await server.setThreadModelOverride({
        threadId: thread.id,
        modelOverride: { providerName: 'work', model: 'gpt-5' }
      })

      const accepted = await server.sendChat({ threadId: thread.id, content: 'Hello' })
      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const assistantMessage = bootstrap.messagesByThread[thread.id]?.[1]

      const branch = await server.createBranch({
        threadId: thread.id,
        messageId: assistantMessage!.id
      })

      assert.equal(branch.thread.icon, '🌊', 'branch should inherit parent icon')
      assert.equal(branch.thread.title, 'Branch of Ocean Thoughts')
      assert.deepEqual(
        branch.thread.modelOverride,
        { providerName: 'work', model: 'gpt-5' },
        'branch should inherit parent model override'
      )
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
