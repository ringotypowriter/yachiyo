import assert from 'node:assert/strict'
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { YachiyoServer } from './YachiyoServer.ts'
import { createInMemoryYachiyoStorage } from './memoryStorage.ts'
import type { ModelStreamRequest } from './types.ts'

async function withServer(
  fn: (input: {
    server: YachiyoServer
    completeRun: (runId: string) => Promise<void>
    modelRequests: ModelStreamRequest[]
    waitForEvent: (type: string) => Promise<unknown>
    workspacePathForThread: (threadId: string) => string
  }) => Promise<void>,
  options: {
    createModelRuntime?: () => {
      streamReply(request: ModelStreamRequest): AsyncIterable<string>
    }
    ensureThreadWorkspace?: (
      threadId: string,
      workspacePathForThread: (threadId: string) => string
    ) => Promise<string>
    cloneThreadWorkspace?: (
      sourceThreadId: string,
      targetThreadId: string,
      workspacePathForThread: (threadId: string) => string
    ) => Promise<string>
    now?: () => Date
  } = {}
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-test-'))
  const settingsPath = join(root, 'config.toml')
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
    const seen = seenEvents.get(type) ?? []
    seen.push(value)
    seenEvents.set(type, seen)

    const queue = waiters.get(type)
    if (!queue || queue.length === 0) return

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
      }))
  })

  const unsubscribe = server.subscribe((event) => {
    settle(event.type, event)
  })

  try {
    await fn({
      server,
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

test('YachiyoServer streams a reply and persists the completed thread state', async () => {
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
  })
})

test('YachiyoServer fails runs cleanly when thread workspace initialization fails', async () => {
  let workspaceInitializationAttempts = 0

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

      await assert.rejects(completeRun(firstRun.runId), /Workspace unavailable/)

      const secondRun = await server.sendChat({
        threadId: thread.id,
        content: 'This thread should not stay wedged as running.'
      })

      await assert.rejects(completeRun(secondRun.runId), /Workspace unavailable/)

      const bootstrap = await server.bootstrap()
      assert.equal(bootstrap.messagesByThread[thread.id]?.length, 2)
    },
    {
      ensureThreadWorkspace: async (threadId, workspacePathForThread) => {
        workspaceInitializationAttempts += 1
        const workspacePath = workspacePathForThread(threadId)
        if (workspaceInitializationAttempts === 1) {
          await mkdir(workspacePath, { recursive: true })
          return workspacePath
        }

        throw new Error('Workspace unavailable')
      }
    }
  )
})

test('YachiyoServer creates a per-thread workspace and persists completed tool calls', async () => {
  let toolWorkspacePath = ''

  await withServer(
    async ({ server, completeRun, workspacePathForThread }) => {
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
      await access(toolWorkspacePath)

      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'List the workspace files.'
      })

      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const toolCalls = bootstrap.toolCallsByThread[thread.id] ?? []

      assert.equal(toolCalls.length, 1)
      assert.equal(toolCalls[0]?.toolName, 'bash')
      assert.equal(toolCalls[0]?.status, 'completed')
      assert.equal(toolCalls[0]?.cwd, toolWorkspacePath)
      assert.equal(toolCalls[0]?.inputSummary, 'pwd && ls')
      assert.equal(toolCalls[0]?.outputSummary, 'exit 0')

      const requestMessageId = bootstrap.messagesByThread[thread.id]?.[0]?.id
      assert.equal(typeof requestMessageId, 'string')

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
              ok: true,
              command: 'pwd && ls',
              cwd: toolWorkspacePath,
              exitCode: 0,
              stdout: `${toolWorkspacePath}\n`,
              stderr: ''
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
    assert.deepEqual(messages[0]?.images, [
      {
        dataUrl: 'data:image/png;base64,AAAA',
        mediaType: 'image/png',
        filename: 'whiteboard.png'
      }
    ])
    assert.deepEqual(modelRequests[0]?.messages.at(-1), {
      role: 'user',
      content: [
        {
          type: 'image',
          image: 'AAAA',
          mediaType: 'image/png'
        }
      ]
    })
  })
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

    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.role, 'user')
    assert.equal(messages[0]?.content, 'Please cancel me halfway. cancel me')
  })
})

test('YachiyoServer bootstrap recovers interrupted runs and marks running tool calls as failed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-recover-test-'))
  const settingsPath = join(root, 'config.toml')
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
    toolName: 'bash',
    status: 'running',
    inputSummary: 'pwd',
    startedAt: createdAt
  })

  const server = new YachiyoServer({
    storage,
    settingsPath,
    now: () => new Date(interruptedAt)
  })

  try {
    const bootstrap = await server.bootstrap()

    assert.deepEqual(bootstrap.latestRunsByThread['thread-1'], {
      id: 'run-1',
      threadId: 'thread-1',
      status: 'failed',
      error: 'Run interrupted before completion.',
      createdAt,
      completedAt: interruptedAt
    })
    assert.equal(bootstrap.toolCallsByThread['thread-1']?.[0]?.status, 'failed')
    assert.equal(
      bootstrap.toolCallsByThread['thread-1']?.[0]?.outputSummary,
      'Run interrupted before completion.'
    )
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('YachiyoServer close waits for active runs to persist a terminal status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-close-test-'))
  const settingsPath = join(root, 'config.toml')
  const storage = createInMemoryYachiyoStorage()
  const server = new YachiyoServer({
    storage,
    settingsPath,
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
              ok: true,
              path: `/tmp/notes-${runAttempt}.txt`,
              workspacePath: '/tmp',
              startLine: 1,
              endLine: 1,
              totalLines: 1,
              totalChars: 5,
              truncated: false,
              content: 'hello'
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

      assert.equal(bootstrap.messagesByThread[thread.id]?.length, 1)
      assert.equal(userMessage?.role, 'user')

      const retried = await server.retryMessage({
        threadId: thread.id,
        messageId: userMessage!.id
      })
      await completeRun(retried.runId)

      bootstrap = await server.bootstrap()
      const assistantReply = (bootstrap.messagesByThread[thread.id] ?? []).find(
        (message) => message.parentMessageId === userMessage?.id && message.role === 'assistant'
      )

      assert.equal(retried.requestMessageId, userMessage?.id)
      assert.equal(retried.sourceAssistantMessageId, undefined)
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
