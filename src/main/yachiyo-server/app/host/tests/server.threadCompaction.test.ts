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

test('YachiyoServer compacts a thread into a new assistant-first thread and allows normal continuation', async () => {
  const requests: ModelStreamRequest[] = []

  await withServer(
    async ({ server, completeRun, workspacePathForThread }) => {
      const sourceThread = await server.createThread()
      const skillDir = join(
        workspacePathForThread(sourceThread.id),
        '.yachiyo',
        'skills',
        'repo-guide'
      )
      await mkdir(skillDir, { recursive: true })
      await writeFile(
        join(skillDir, 'SKILL.md'),
        ['---', 'name: repo-guide', 'description: Workspace guide', '---', '', '# Repo Guide'].join(
          '\n'
        ),
        'utf8'
      )
      const sourceAccepted = await server.sendChat({
        threadId: sourceThread.id,
        content: 'We decided to ship the desktop update on Friday.',
        enabledTools: ['read'],
        enabledSkillNames: []
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
      const sourceRequest = requests.find((request) => request.purpose === 'chat')
      assert.ok(sourceRequest)
      assert.ok(handoffRequest)
      assert.deepEqual(
        Object.keys(handoffRequest.tools ?? {}).sort(),
        Object.keys(sourceRequest.tools ?? {}).sort()
      )
      assert.equal(handoffRequest.toolChoice, sourceRequest.toolChoice)
      assert.equal(handoffRequest.promptCacheKey, sourceThread.id)
      const handoffPrefix = JSON.stringify(
        handoffRequest.messages.slice(0, sourceRequest.messages.length).map((message) => ({
          role: message.role,
          content: message.content
        }))
      )
      const sourcePrefix = JSON.stringify(
        sourceRequest.messages.map((message) => ({ role: message.role, content: message.content }))
      )
      const firstPrefixDiff = [...handoffPrefix].findIndex(
        (char, index) => char !== sourcePrefix[index]
      )
      assert.equal(
        handoffPrefix,
        sourcePrefix,
        `prefix differs at ${firstPrefixDiff}: actual=${handoffPrefix.slice(firstPrefixDiff - 80, firstPrefixDiff + 160)} expected=${sourcePrefix.slice(firstPrefixDiff - 80, firstPrefixDiff + 160)}`
      )
      assert.equal(handoffRequest.messages.at(-1)?.role, 'user')
      assert.match(String(handoffRequest.messages.at(-1)?.content), /visible handoff/i)
      assert.equal(
        handoffRequest.messages.some(
          (message) =>
            message.role === 'user' &&
            String(message.content).includes('We decided to ship the desktop update on Friday.')
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

test('YachiyoServer.compactThreadToAnotherThread keeps handoff running after refusing tool execution', async () => {
  const requests: ModelStreamRequest[] = []
  const refusedToolErrors: string[] = []

  await withServer(
    async ({ server, completeRun }) => {
      const sourceThread = await server.createThread()
      const sourceAccepted = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Remember that handoff generation must use the existing context only.',
        enabledTools: ['read'],
        enabledSkillNames: []
      })
      await completeRun(sourceAccepted.runId)

      const compacted = await server.compactThreadToAnotherThread({
        threadId: sourceThread.id
      })
      await completeRun(compacted.runId)

      const handoffRequest = requests.findLast((request) => request.purpose === 'thread-handoff')
      assert.ok(handoffRequest)
      assert.equal(Boolean(handoffRequest.tools?.read), true)
      assert.equal(handoffRequest.maxToolSteps, undefined)
      assert.ok(handoffRequest.stopWhen)
      assert.deepEqual(refusedToolErrors, [
        'Tool execution is disabled during handoff creation. Continue writing the handoff from the existing conversation context without tools.'
      ])

      const bootstrap = await server.bootstrap()
      const destinationMessages = bootstrap.messagesByThread[compacted.thread.id] ?? []
      assert.equal(destinationMessages.at(-1)?.role, 'assistant')
      assert.equal(destinationMessages.at(-1)?.status, 'completed')
      assert.equal(destinationMessages.at(-1)?.content, 'Visible handoff after refusal')
      assert.equal(destinationMessages.at(-1)?.responseMessages, undefined)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (request.purpose !== 'thread-handoff') {
            yield 'Source response'
            return
          }

          const readTool = request.tools?.read as { execute?: () => Promise<unknown> } | undefined
          assert.ok(readTool?.execute)

          let toolError: Error | undefined
          try {
            await readTool.execute()
          } catch (error) {
            toolError = error instanceof Error ? error : new Error(String(error))
          }
          assert.ok(toolError)
          refusedToolErrors.push(toolError.message)

          const decision = request.onToolCallError?.({
            error: toolError,
            toolCall: {
              input: { path: 'README.md' },
              toolCallId: 'handoff-read-1',
              toolName: 'read'
            }
          })
          if (decision === 'abort') {
            throw toolError
          }

          const stopWhen = request.stopWhen
          assert.ok(stopWhen)
          const stopConditions = Array.isArray(stopWhen) ? stopWhen : [stopWhen]
          const firstRefusalShouldStop = (
            await Promise.all(
              stopConditions.map((condition) =>
                condition({
                  steps: [
                    {
                      toolCalls: [{ toolCallId: 'handoff-read-1', toolName: 'read' }],
                      toolResults: [{ toolCallId: 'handoff-read-1', toolName: 'read' }]
                    } as never
                  ]
                })
              )
            )
          ).some(Boolean)
          assert.equal(firstRefusalShouldStop, false)

          request.onToolCallError?.({
            error: toolError,
            toolCall: {
              input: { path: 'README.md' },
              toolCallId: 'handoff-read-2',
              toolName: 'read'
            }
          })
          const secondRefusalShouldStop = (
            await Promise.all(
              stopConditions.map((condition) =>
                condition({
                  steps: [
                    {
                      toolCalls: [{ toolCallId: 'handoff-read-1', toolName: 'read' }],
                      toolResults: [{ toolCallId: 'handoff-read-1', toolName: 'read' }]
                    },
                    {
                      toolCalls: [{ toolCallId: 'handoff-read-2', toolName: 'read' }],
                      toolResults: [{ toolCallId: 'handoff-read-2', toolName: 'read' }]
                    }
                  ] as never
                })
              )
            )
          ).some(Boolean)
          assert.equal(secondRefusalShouldStop, true)

          yield 'Visible handoff after refusal'
          request.onFinish?.({
            promptTokens: 1,
            completionTokens: 1,
            totalPromptTokens: 1,
            totalCompletionTokens: 1,
            finishReason: 'stop',
            responseMessages: [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool-call',
                    toolCallId: 'handoff-read-1',
                    toolName: 'read',
                    input: { path: 'README.md' }
                  }
                ]
              },
              {
                role: 'tool',
                content: [
                  {
                    type: 'tool-error',
                    toolCallId: 'handoff-read-1',
                    toolName: 'read',
                    error: toolError.message
                  }
                ]
              },
              {
                role: 'assistant',
                content: [{ type: 'text', text: 'Visible handoff after refusal' }]
              }
            ]
          })
        }
      })
    }
  )
})

test('YachiyoServer.compactThreadToAnotherThread asks for a short handoff when the source thread is empty', async () => {
  const requests: ModelStreamRequest[] = []

  await withServer(
    async ({ server, completeRun }) => {
      const sourceThread = await server.createThread()

      const compacted = await server.compactThreadToAnotherThread({
        threadId: sourceThread.id
      })
      await completeRun(compacted.runId)

      const handoffRequest = requests.findLast((request) => request.purpose === 'thread-handoff')
      assert.ok(handoffRequest)

      const lastMessage = handoffRequest.messages.at(-1)
      assert.equal(lastMessage?.role, 'user')
      assert.match(
        String(lastMessage?.content),
        /The earlier thread did not establish much context yet/
      )
      assert.match(String(lastMessage?.content), /keep the handoff very short/)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)
          yield request.purpose === 'thread-handoff' ? 'Minimal handoff' : 'Hello world'
        }
      })
    }
  )
})

test('YachiyoServer.compactThreadToAnotherThread preserves default skill selections from the source turn', async () => {
  const requests: ModelStreamRequest[] = []

  await withServer(
    async ({ server, completeRun, workspacePathForThread }) => {
      const sourceThread = await server.createThread()
      const skillDir = join(
        workspacePathForThread(sourceThread.id),
        '.yachiyo',
        'skills',
        'repo-guide'
      )
      await mkdir(skillDir, { recursive: true })
      await writeFile(
        join(skillDir, 'SKILL.md'),
        ['---', 'name: repo-guide', 'description: Workspace guide', '---', '', '# Repo Guide'].join(
          '\n'
        ),
        'utf8'
      )

      const config = await server.getConfig()
      await server.saveConfig({
        ...config,
        skills: {
          ...(config.skills ?? {}),
          enabled: ['repo-guide'],
          disabled: []
        }
      })

      const accepted = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Use the configured skill while planning the release.',
        enabledTools: ['read']
      })
      assertAcceptedHasUserMessage(accepted)
      await completeRun(accepted.runId)

      const afterSource = await server.bootstrap()
      const sourceUser = (afterSource.messagesByThread[sourceThread.id] ?? []).find(
        (message) => message.id === accepted.userMessage.id
      )
      assert.equal(sourceUser?.turnContext?.enabledSkillNames?.includes('repo-guide'), true)

      await server.saveConfig({
        ...(await server.getConfig()),
        skills: {
          enabled: [],
          disabled: ['repo-guide']
        }
      })

      const compacted = await server.compactThreadToAnotherThread({
        threadId: sourceThread.id
      })
      await completeRun(compacted.runId)

      const sourceRequest = requests.find((request) => request.purpose === 'chat')
      const handoffRequest = requests.findLast((request) => request.purpose === 'thread-handoff')
      assert.ok(sourceRequest)
      assert.ok(handoffRequest)
      assert.equal(
        sourceRequest.messages.some(
          (message) =>
            message.role === 'system' &&
            typeof message.content === 'string' &&
            message.content.includes('repo-guide: Workspace guide')
        ),
        true
      )
      assert.equal(
        handoffRequest.messages.some(
          (message) =>
            message.role === 'system' &&
            typeof message.content === 'string' &&
            message.content.includes('repo-guide: Workspace guide')
        ),
        true
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)
          yield request.purpose === 'thread-handoff' ? 'Visible handoff' : 'Hello world'
        }
      })
    }
  )
})
