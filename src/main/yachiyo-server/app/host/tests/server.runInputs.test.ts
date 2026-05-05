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
  let markReady: (() => void) | null = null
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })
  let markSteerQueued: (() => void) | null = null
  const steerQueued = new Promise<void>((resolve) => {
    markSteerQueued = resolve
  })

  await withServer(
    async ({ server, completeRun }) => {
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

      await ready

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

      markSteerQueued!()
      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const messages = bootstrap.messagesByThread[thread.id] ?? []

      assert.equal(steerAccepted.kind, 'active-run-steer-pending')
      assert.equal(steerAccepted.runId, accepted.runId)
      assert.equal(messages.length, 4)
      assert.equal(messages[0]?.content, 'Start with the code path')
      // Pre-steer assistant response (completed naturally)
      assert.equal(messages[1]?.role, 'assistant')
      assert.equal(messages[1]?.status, 'completed')
      // Steer user message (parented under assistant)
      assert.equal(messages[2]?.content, 'Use the screenshot instead')
      assert.equal(messages[2]?.parentMessageId, messages[1]?.id)
      const steerImage = messages[2]?.images?.[0]
      assert.equal(steerImage?.dataUrl, 'data:image/png;base64,BBBB')
      assert.equal(steerImage?.mediaType, 'image/png')
      assert.equal(steerImage?.filename, 'screenshot.png')
      assert.ok(
        typeof steerImage?.workspacePath === 'string' &&
          steerImage.workspacePath.endsWith('screenshot.png'),
        'steer image should be saved to workspace'
      )
      // Post-steer assistant response
      assert.equal(messages[3]?.role, 'assistant')
      assert.equal(messages[3]?.parentMessageId, messages[2]?.id)
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
            markReady?.()
            await steerQueued
            return
          }

          yield 'Steered'
          yield ' reply'
        }
      })
    }
  )
})

test('YachiyoServer does not run memory recall on a steer leg', async () => {
  const recalledQueries: string[] = []
  let attempt = 0
  let markReady: (() => void) | null = null
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })
  let markSteerQueued: (() => void) | null = null
  const steerQueued = new Promise<void>((resolve) => {
    markSteerQueued = resolve
  })

  await withServer(
    async ({ completeRun, server }) => {
      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Plan the deploy'
      })
      assertAcceptedHasUserMessage(accepted)

      await ready

      const steerAccepted = await server.sendChat({
        threadId: thread.id,
        content: 'Actually use the staging plan',
        mode: 'steer'
      })

      markSteerQueued!()
      await completeRun(accepted.runId)

      assert.equal(steerAccepted.kind, 'active-run-steer-pending')
      assert.deepEqual(
        recalledQueries,
        ['Plan the deploy'],
        'recall should fire only for the opening leg, never for the steer continuation'
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply() {
          if (attempt === 0) {
            attempt += 1
            yield 'Partial'
            markReady?.()
            await steerQueued
            return
          }

          yield 'Steered'
          yield ' reply'
        }
      }),
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

test('YachiyoServer debounces duplicate sendChat requests for a fresh run', async () => {
  let now = new Date('2026-04-05T00:00:00.000Z')

  await withServer(
    async ({ server, waitForEvent }) => {
      await server.upsertProvider({
        name: 'default',
        type: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        modelList: { enabled: ['gpt-5'], disabled: [] }
      })

      const thread = await server.createThread()
      const firstAccepted = await server.sendChat({
        threadId: thread.id,
        content: 'Same request'
      })
      const duplicateAccepted = await server.sendChat({
        threadId: thread.id,
        content: 'Same request'
      })

      assert.equal(duplicateAccepted.kind, 'run-started')
      assert.equal(firstAccepted.runId, duplicateAccepted.runId)
      assertAcceptedHasUserMessage(firstAccepted)
      assertAcceptedHasUserMessage(duplicateAccepted)
      assert.equal(firstAccepted.userMessage.id, duplicateAccepted.userMessage.id)

      const bootstrap = await server.bootstrap()
      assert.equal(bootstrap.latestRunsByThread[thread.id]?.id, firstAccepted.runId)
      assert.deepEqual(
        (bootstrap.messagesByThread[thread.id] ?? [])
          .filter((message) => message.role === 'user')
          .map((message) => message.content),
        ['Same request']
      )

      await waitForEvent('run.completed')

      now = new Date('2026-04-05T00:00:00.500Z')
      const secondAccepted = await server.sendChat({
        threadId: thread.id,
        content: 'Same request'
      })

      assert.equal(secondAccepted.kind, 'run-started')
      assert.notEqual(secondAccepted.runId, firstAccepted.runId)
      assertAcceptedHasUserMessage(secondAccepted)
      assert.notEqual(secondAccepted.userMessage.id, firstAccepted.userMessage.id)
    },
    {
      now: () => now
    }
  )
})
