import assert from 'node:assert/strict'
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { YachiyoServer } from './YachiyoServer.ts'
import { RetryableRunError } from '../runtime/runtimeErrors.ts'
import type { ModelStreamRequest } from '../runtime/types.ts'
import type { SoulDocument } from '../runtime/soul.ts'
import { readUserDocument, writeUserDocument } from '../runtime/user.ts'
import { createInMemoryYachiyoStorage } from '../storage/memoryStorage.ts'
import type { MemoryService } from '../services/memory/memoryService.ts'
import type { UserDocument } from '../../../shared/yachiyo/protocol.ts'

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
    jotdownStore?: import('../services/jotdownStore.ts').JotdownStore
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
      const persistedThread = bootstrap.threads.find((candidate) => candidate.id === thread.id)
      assert.ok(stoppedMessage, 'cancelled run should persist a stopped assistant message')
      assert.equal(
        persistedThread?.headMessageId,
        stoppedMessage?.id,
        'cancelled run should move the thread head to the stopped assistant'
      )

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

test('YachiyoServer binds recovered tool calls when retry backoff is cancelled', async () => {
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
      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const stoppedMessage = (bootstrap.messagesByThread[thread.id] ?? []).find(
        (message) => message.role === 'assistant' && message.status === 'stopped'
      )
      const toolCall = (bootstrap.toolCallsByThread[thread.id] ?? [])[0]
      const persistedThread = bootstrap.threads.find((candidate) => candidate.id === thread.id)

      assert.ok(stoppedMessage)
      assert.equal(toolCall?.status, 'completed')
      assert.equal(toolCall?.assistantMessageId, stoppedMessage?.id)
      assert.equal(
        persistedThread?.headMessageId,
        stoppedMessage?.id,
        'retry-backoff cancellation should keep the stopped assistant on the active path'
      )
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
            // Honor the typed runtime contract: the real model runtime would
            // classify a 5xx as a transient transport failure and wrap it in
            // RetryableRunError at its boundary before the outer recovery
            // path sees it. The mock does the same.
            throw new RetryableRunError('temporary upstream failure', {
              cause: Object.assign(new Error('temporary upstream failure'), { status: 500 })
            })
          }

          yield 'Recovered answer'
        }
      })
    }
  )
})
