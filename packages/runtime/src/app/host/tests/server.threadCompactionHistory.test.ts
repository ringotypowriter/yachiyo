import assert from 'node:assert/strict'
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { YachiyoServer } from '../YachiyoServer.ts'
import { prepareAiSdkMessages } from '../../../runtime/messages/messagePrepare.ts'
import type { ModelStreamRequest } from '../../../runtime/models/types.ts'
import type { SoulDocument } from '../../../runtime/profiles/soul.ts'
import { readUserDocument, writeUserDocument } from '../../../runtime/profiles/user.ts'
import { createInMemoryYachiyoStorage } from '../../../storage/memoryStorage.ts'
import type { MemoryService } from '../../../services/memory/memoryService.ts'
import type { UserDocument } from '@yachiyo/shared/protocol'

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

test('YachiyoServer.compactThreadToAnotherThread sends full source tool-result history', async () => {
  const requests: ModelStreamRequest[] = []
  const toolOutputs = [
    'FIRST_FULL_TOOL_OUTPUT_SHOULD_SURVIVE',
    'SECOND_FULL_TOOL_OUTPUT_SHOULD_SURVIVE'
  ]

  await withServer(
    async ({ server, completeRun }) => {
      const config = await server.getConfig()
      await server.saveConfig({
        ...config,
        chat: {
          ...(config.chat ?? {}),
          stripCompact: true,
          stripCompactThresholdTokens: 1
        }
      })

      const sourceThread = await server.createThread()
      const first = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Run the first diagnostic.'
      })
      await completeRun(first.runId)

      const second = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Run the second diagnostic.'
      })
      await completeRun(second.runId)

      const compacted = await server.compactThreadToAnotherThread({
        threadId: sourceThread.id
      })
      await completeRun(compacted.runId)

      const handoffRequest = requests.findLast((request) => request.purpose === 'thread-handoff')
      assert.ok(handoffRequest)
      const handoffMessages = JSON.stringify(
        handoffRequest.messages.map((message) => ({
          role: message.role,
          content: message.content
        }))
      )
      assert.match(handoffMessages, /FIRST_FULL_TOOL_OUTPUT_SHOULD_SURVIVE/)
      assert.match(handoffMessages, /SECOND_FULL_TOOL_OUTPUT_SHOULD_SURVIVE/)
      assert.doesNotMatch(handoffMessages, /\[Stripped:/)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (request.purpose === 'thread-handoff') {
            yield 'Visible handoff'
            return
          }

          const output = toolOutputs.shift()
          assert.ok(output)
          const toolCallId = `tool-${output}`

          yield 'Before diagnostic'
          request.onToolCallStart?.({
            abortSignal: request.signal,
            experimental_context: undefined,
            functionId: undefined,
            messages: request.messages,
            metadata: undefined,
            model: undefined,
            stepNumber: 0,
            toolCall: {
              input: { command: 'diagnostic' },
              toolCallId,
              toolName: 'bash'
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
              content: [{ type: 'text', text: output }],
              details: {
                command: 'diagnostic',
                cwd: '/tmp/workspace',
                exitCode: 0,
                stderr: '',
                stdout: output
              },
              metadata: {
                cwd: '/tmp/workspace',
                exitCode: 0
              }
            },
            toolCall: {
              input: { command: 'diagnostic' },
              toolCallId,
              toolName: 'bash'
            }
          } as never)
          yield ' After diagnostic'
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
                  { type: 'text', text: 'Before diagnostic' },
                  {
                    type: 'tool-call',
                    toolCallId,
                    toolName: 'bash',
                    input: { command: 'diagnostic' }
                  }
                ]
              },
              {
                role: 'tool',
                content: [
                  {
                    type: 'tool-result',
                    toolCallId,
                    toolName: 'bash',
                    output: { type: 'text', value: output }
                  }
                ]
              },
              {
                role: 'assistant',
                content: [{ type: 'text', text: ' After diagnostic' }]
              }
            ]
          })
        }
      })
    }
  )
})

function assertToolNamesInclude(
  tools: Record<string, unknown> | undefined,
  expectedToolNames: readonly string[]
): void {
  const toolNames = Object.keys(tools ?? {})
  for (const toolName of expectedToolNames) {
    assert.equal(toolNames.includes(toolName), true, `expected registered tool ${toolName}`)
  }
}

test('YachiyoServer.compactThreadToAnotherThread keeps the runtime-prepared source prefix stable after tool history', async () => {
  const requests: ModelStreamRequest[] = []
  const toolOutputs = ['FIRST_PREFIX_TOOL_OUTPUT', 'SECOND_PREFIX_TOOL_OUTPUT']

  await withServer(
    async ({ server, completeRun }) => {
      await server.upsertProvider({
        name: 'openai-work',
        type: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.deepseek.com/v1',
        modelList: {
          enabled: ['deepseek-v4-pro'],
          disabled: []
        }
      })

      const sourceThread = await server.createThread()
      await server.setThreadModelOverride({
        threadId: sourceThread.id,
        modelOverride: { providerName: 'openai-work', model: 'deepseek-v4-pro' }
      })

      const first = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Run the first prefix diagnostic.',
        toolPreset: ['bash'],
        enabledSkillNames: []
      })
      await completeRun(first.runId)

      const second = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Run the second prefix diagnostic.',
        toolPreset: ['bash'],
        enabledSkillNames: []
      })
      await completeRun(second.runId)

      const compacted = await server.compactThreadToAnotherThread({
        threadId: sourceThread.id
      })
      await completeRun(compacted.runId)

      const chatRequests = requests.filter((request) => request.purpose === 'chat')
      const secondSourceRequest = chatRequests.find((request) =>
        request.messages.some(
          (message) =>
            message.role === 'user' &&
            String(message.content).includes('Run the second prefix diagnostic.')
        )
      )
      const handoffRequest = requests.findLast((request) => request.purpose === 'thread-handoff')
      assert.ok(secondSourceRequest)
      assert.ok(handoffRequest)

      const sourcePrepared = prepareAiSdkMessages(secondSourceRequest.messages)
      const handoffPreparedPrefix = prepareAiSdkMessages(handoffRequest.messages).slice(
        0,
        sourcePrepared.length
      )
      assert.deepEqual(handoffPreparedPrefix, sourcePrepared)
      assertToolNamesInclude(secondSourceRequest.tools, ['bash'])
      assertToolNamesInclude(handoffRequest.tools, ['bash'])
      assert.equal(handoffRequest.toolChoice, secondSourceRequest.toolChoice)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (request.purpose === 'thread-handoff') {
            yield 'Visible handoff'
            return
          }

          const output = toolOutputs.shift()
          assert.ok(output)
          const toolCallId = `tool-${output}`

          yield 'Before diagnostic'
          request.onToolCallStart?.({
            abortSignal: request.signal,
            experimental_context: undefined,
            functionId: undefined,
            messages: request.messages,
            metadata: undefined,
            model: undefined,
            stepNumber: 0,
            toolCall: {
              input: { command: 'diagnostic' },
              toolCallId,
              toolName: 'bash'
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
              content: [{ type: 'text', text: output }],
              details: {
                command: 'diagnostic',
                cwd: '/tmp/workspace',
                exitCode: 0,
                stderr: '',
                stdout: output
              },
              metadata: {
                cwd: '/tmp/workspace',
                exitCode: 0
              }
            },
            toolCall: {
              input: { command: 'diagnostic' },
              toolCallId,
              toolName: 'bash'
            }
          } as never)
          yield ' After diagnostic'
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
                  { type: 'text', text: 'Before diagnostic' },
                  {
                    type: 'tool-call',
                    toolCallId,
                    toolName: 'bash',
                    input: { command: 'diagnostic' }
                  }
                ]
              },
              {
                role: 'tool',
                content: [
                  {
                    type: 'tool-result',
                    toolCallId,
                    toolName: 'bash',
                    output: { type: 'text', value: output }
                  }
                ]
              },
              {
                role: 'assistant',
                content: [{ type: 'text', text: ' After diagnostic' }]
              }
            ]
          })
        }
      })
    }
  )
})

test('YachiyoServer.compactThreadToAnotherThread inherits the source thread model override', async () => {
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
          disabled: []
        }
      })

      const sourceThread = await server.createThread()
      await server.setThreadModelOverride({
        threadId: sourceThread.id,
        modelOverride: { providerName: 'work', model: 'gpt-5' }
      })
      const sourceAccepted = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Preserve the chosen model across handoff.'
      })
      await completeRun(sourceAccepted.runId)

      const compacted = await server.compactThreadToAnotherThread({
        threadId: sourceThread.id
      })
      await completeRun(compacted.runId)

      assert.deepEqual(compacted.thread.modelOverride, {
        providerName: 'work',
        model: 'gpt-5'
      })

      const handoffRequest = requests.findLast((request) => request.purpose === 'thread-handoff')
      assert.ok(handoffRequest)
      assert.equal(handoffRequest.settings.model, 'gpt-5')
      assert.equal(handoffRequest.settings.providerName, 'work')
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)
          yield 'ok'
        }
      })
    }
  )
})

test('YachiyoServer.compactThreadToAnotherThread uses the requested reasoning effort', async () => {
  const requests: ModelStreamRequest[] = []

  await withServer(
    async ({ server, completeRun }) => {
      const sourceThread = await server.createThread()
      const sourceAccepted = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Preserve the selected reasoning effort across handoff.'
      })
      await completeRun(sourceAccepted.runId)

      const compacted = await server.compactThreadToAnotherThread({
        threadId: sourceThread.id,
        reasoningEffort: 'high'
      })
      await completeRun(compacted.runId)

      const handoffRequest = requests.findLast((request) => request.purpose === 'thread-handoff')
      assert.ok(handoffRequest)
      assert.equal(handoffRequest.reasoningEffort, 'high')
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)
          yield 'ok'
        }
      })
    }
  )
})

test('YachiyoServer.compactThreadToAnotherThread uses the saved thread reasoning effort', async () => {
  const requests: ModelStreamRequest[] = []

  await withServer(
    async ({ server, completeRun }) => {
      const sourceThread = await server.createThread()
      await server.setThreadReasoningEffort({
        threadId: sourceThread.id,
        reasoningEffort: 'high'
      })
      const sourceAccepted = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Preserve the saved reasoning effort across handoff.'
      })
      await completeRun(sourceAccepted.runId)

      const compacted = await server.compactThreadToAnotherThread({
        threadId: sourceThread.id
      })
      await completeRun(compacted.runId)

      assert.equal(compacted.thread.reasoningEffort, 'high')
      const handoffRequest = requests.findLast((request) => request.purpose === 'thread-handoff')
      assert.ok(handoffRequest)
      assert.equal(handoffRequest.reasoningEffort, 'high')
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)
          yield 'ok'
        }
      })
    }
  )
})

test('YachiyoServer.compactThreadToAnotherThread preserves Anthropic cache breakpoints', async () => {
  const requests: ModelStreamRequest[] = []
  const hasAnthropicCacheBreakpoint = (
    message: ModelStreamRequest['messages'][number]
  ): boolean => {
    const providerOptions = message.providerOptions as
      | { anthropic?: { cacheControl?: { type?: unknown } } }
      | undefined
    return providerOptions?.anthropic?.cacheControl?.type === 'ephemeral'
  }

  await withServer(
    async ({ server, completeRun }) => {
      await server.upsertProvider({
        name: 'anthropic-work',
        type: 'anthropic',
        apiKey: 'sk-ant-test',
        baseUrl: '',
        modelList: {
          enabled: ['claude-opus-4-6'],
          disabled: []
        }
      })

      const sourceThread = await server.createThread()
      await server.setThreadModelOverride({
        threadId: sourceThread.id,
        modelOverride: { providerName: 'anthropic-work', model: 'claude-opus-4-6' }
      })
      const sourceAccepted = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Preserve Anthropic prompt caching across handoff.'
      })
      await completeRun(sourceAccepted.runId)

      const compacted = await server.compactThreadToAnotherThread({
        threadId: sourceThread.id
      })
      await completeRun(compacted.runId)

      const sourceRequest = requests.find((request) => request.purpose === 'chat')
      const handoffRequest = requests.findLast((request) => request.purpose === 'thread-handoff')
      assert.ok(sourceRequest)
      assert.ok(handoffRequest)
      assert.equal(sourceRequest.settings.provider, 'anthropic')
      assert.equal(handoffRequest.settings.provider, 'anthropic')
      assert.deepEqual(
        sourceRequest.messages.filter(hasAnthropicCacheBreakpoint).map((m) => m.role),
        ['system']
      )
      assert.deepEqual(
        handoffRequest.messages.filter(hasAnthropicCacheBreakpoint).map((m) => m.role),
        ['system', 'assistant']
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
