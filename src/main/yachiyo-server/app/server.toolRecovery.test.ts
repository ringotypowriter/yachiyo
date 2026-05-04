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
import type {
  ChatAccepted,
  ChatAcceptedWithUserMessage,
  UserDocument
} from '../../../shared/yachiyo/protocol.ts'

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

test('YachiyoServer preserves assistant-tool-assistant ordering across recovery', async () => {
  const requests: ModelStreamRequest[] = []
  let attempt = 0

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
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Inspect the workspace and continue after the tool result.'
      })
      assertAcceptedHasUserMessage(accepted)

      await completeRun(accepted.runId)

      assert.equal(requests.length, 2)
      const recoveryMessages = requests[1]?.messages ?? []
      const trailingAssistantIndex = recoveryMessages.findIndex(
        (message) =>
          message.role === 'assistant' &&
          Array.isArray(message.content) &&
          message.content.some((part) => part.type === 'text' && part.text === 'After tool. ')
      )
      const toolResultIndex = recoveryMessages.findIndex(
        (message) =>
          message.role === 'tool' &&
          Array.isArray(message.content) &&
          message.content.some(
            (part) =>
              part.type === 'tool-result' &&
              part.toolCallId === 'tool-bash-order-1' &&
              part.output?.type === 'content' &&
              Array.isArray(part.output.value) &&
              part.output.value[0]?.type === 'text' &&
              part.output.value[0]?.text === '/tmp/workspace'
          )
      )
      const continuationPromptIndex = recoveryMessages.findIndex(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes(
            'The previous assistant response was interrupted by a recoverable transport failure.'
          )
      )

      assert.notEqual(toolResultIndex, -1)
      assert.notEqual(trailingAssistantIndex, -1)
      assert.notEqual(continuationPromptIndex, -1)
      assert.ok(
        toolResultIndex < trailingAssistantIndex &&
          trailingAssistantIndex < continuationPromptIndex,
        'recovery should preserve the assistant text that happened after the tool result'
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (attempt === 0) {
            attempt += 1

            yield 'Before tool. '

            request.onToolCallStart?.({
              abortSignal: request.signal,
              experimental_context: undefined,
              functionId: undefined,
              messages: request.messages,
              metadata: undefined,
              model: undefined,
              stepNumber: 0,
              toolCall: {
                input: { command: 'pwd' },
                toolCallId: 'tool-bash-order-1',
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
                content: [{ type: 'text', text: '/tmp/workspace\n' }],
                details: {
                  command: 'pwd',
                  cwd: '/tmp/workspace',
                  exitCode: 0,
                  stderr: '',
                  stdout: '/tmp/workspace\n'
                },
                metadata: {
                  cwd: '/tmp/workspace',
                  exitCode: 0
                }
              },
              toolCall: {
                input: { command: 'pwd' },
                toolCallId: 'tool-bash-order-1',
                toolName: 'bash'
              }
            } as never)

            yield 'After tool. '

            const cause = Object.assign(new Error('net::ERR_CONNECTION_CLOSED'), { status: 0 })
            throw new RetryableRunError('net::ERR_CONNECTION_CLOSED', { cause })
          }

          yield 'Final answer.'
        }
      })
    }
  )
})

test('YachiyoServer ignores late tool updates after a tool call has already finished', async () => {
  const toolUpdates: Array<{ assistantMessageId?: string; status: string }> = []

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
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'List the workspace files.'
      })
      assertAcceptedHasUserMessage(accepted)

      const unsubscribe = server.subscribe((event) => {
        if (event.type !== 'tool.updated' || event.runId !== accepted.runId) {
          return
        }

        toolUpdates.push({
          ...(event.toolCall.assistantMessageId
            ? { assistantMessageId: event.toolCall.assistantMessageId }
            : {}),
          status: event.toolCall.status
        })
      })

      await completeRun(accepted.runId)
      unsubscribe()

      const bootstrap = await server.bootstrap()
      const toolCalls = bootstrap.toolCallsByThread[thread.id] ?? []

      assert.equal(toolCalls.length, 1)
      assert.equal(toolCalls[0]?.status, 'completed')
      assert.equal(toolCalls[0]?.outputSummary, 'exit 0')
      assert.equal(typeof toolCalls[0]?.finishedAt, 'string')
      assert.deepEqual(
        toolUpdates.map((toolCall) => toolCall.status),
        ['running', 'completed', 'completed']
      )
      assert.equal(toolUpdates[0]?.assistantMessageId, undefined)
      assert.equal(toolUpdates[1]?.assistantMessageId, undefined)
      assert.equal(toolUpdates[2]?.assistantMessageId, toolCalls[0]?.assistantMessageId)
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
              input: { command: 'pwd' },
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
              content: [{ type: 'text', text: '/tmp/workspace\n' }],
              details: {
                command: 'pwd',
                cwd: '/tmp/workspace',
                exitCode: 0,
                stderr: '',
                stdout: '/tmp/workspace\n'
              },
              metadata: {
                cwd: '/tmp/workspace',
                exitCode: 0
              }
            },
            toolCall: {
              input: { command: 'pwd' },
              toolCallId: 'tool-bash-1',
              toolName: 'bash'
            }
          } as never)

          request.onToolCallUpdate?.({
            output: {
              content: [{ type: 'text', text: '/tmp/workspace\n' }],
              details: {
                command: 'pwd',
                cwd: '/tmp/workspace',
                stderr: '',
                stdout: '/tmp/workspace\n'
              },
              metadata: {
                cwd: '/tmp/workspace'
              }
            },
            toolCall: {
              input: { command: 'pwd' },
              toolCallId: 'tool-bash-1',
              toolName: 'bash'
            }
          } as never)

          yield 'Done'
        }
      }),
      now: (() => {
        let tick = 0
        return () => new Date(`2026-03-15T00:00:${String(tick++).padStart(2, '0')}.000Z`)
      })()
    }
  )
})

test('YachiyoServer persists tool finishes that arrive without a prior tool start event', async () => {
  const toolUpdates: Array<{ assistantMessageId?: string; status: string }> = []

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
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'List the workspace files.'
      })
      assertAcceptedHasUserMessage(accepted)

      const unsubscribe = server.subscribe((event) => {
        if (event.type !== 'tool.updated' || event.runId !== accepted.runId) {
          return
        }

        toolUpdates.push({
          ...(event.toolCall.assistantMessageId
            ? { assistantMessageId: event.toolCall.assistantMessageId }
            : {}),
          status: event.toolCall.status
        })
      })

      await completeRun(accepted.runId)
      unsubscribe()

      const bootstrap = await server.bootstrap()
      const toolCalls = bootstrap.toolCallsByThread[thread.id] ?? []

      assert.equal(toolCalls.length, 1)
      assert.equal(toolCalls[0]?.status, 'completed')
      assert.equal(toolCalls[0]?.toolName, 'bash')
      assert.equal(toolCalls[0]?.inputSummary, 'pwd')
      assert.equal(toolCalls[0]?.outputSummary, 'exit 0')
      assert.equal(toolCalls[0]?.requestMessageId, accepted.userMessage.id)
      assert.equal(typeof toolCalls[0]?.assistantMessageId, 'string')
      assert.deepEqual(
        toolUpdates.map((toolCall) => toolCall.status),
        ['completed', 'completed']
      )
      assert.equal(toolUpdates[0]?.assistantMessageId, undefined)
      assert.equal(toolUpdates[1]?.assistantMessageId, toolCalls[0]?.assistantMessageId)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
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
              content: [{ type: 'text', text: '/tmp/workspace\n' }],
              details: {
                command: 'pwd',
                cwd: '/tmp/workspace',
                exitCode: 0,
                stderr: '',
                stdout: '/tmp/workspace\n'
              },
              metadata: {
                cwd: '/tmp/workspace',
                exitCode: 0
              }
            },
            toolCall: {
              input: { command: 'pwd' },
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

test('YachiyoServer emits thread.state.replaced with the steer message when a pending steer fires after the tool finishes', async () => {
  const requests: ModelStreamRequest[] = []
  let attempt = 0
  let releaseToolExecution: (() => void) | null = null
  let markToolExecutionStarted: (() => void) | null = null
  const toolExecutionStarted = new Promise<void>((resolve) => {
    markToolExecutionStarted = resolve
  })

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
        content: 'List the workspace files.'
      })
      assertAcceptedHasUserMessage(accepted)

      await toolExecutionStarted

      const steerAccepted = await server.sendChat({
        threadId: thread.id,
        content: 'Actually summarize the result instead',
        mode: 'steer'
      })

      assert.equal(steerAccepted.kind, 'active-run-steer-pending')

      releaseToolExecution?.()

      const stateReplaced = (await waitForEvent('thread.state.replaced')) as {
        threadId: string
        thread: { headMessageId?: string }
        messages: Array<{ id: string; role: string; content: string }>
        toolCalls: Array<{ status: string; requestMessageId?: string }>
      }

      assert.equal(stateReplaced.threadId, thread.id)
      // In the safe-steer flow: user request → completed assistant → steer user
      assert.ok(stateReplaced.messages.length >= 3, 'should have at least 3 messages')
      assert.equal(stateReplaced.messages[0]?.role, 'user')
      assert.equal(stateReplaced.messages[0]?.content, 'List the workspace files.')
      const steerMsg = stateReplaced.messages.find(
        (m) => m.role === 'user' && m.content === 'Actually summarize the result instead'
      )
      assert.ok(steerMsg, 'steer message should be in state')
      assert.equal(stateReplaced.toolCalls.length, 1)
      assert.equal(stateReplaced.toolCalls[0]?.status, 'completed')

      await completeRun(accepted.runId)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (attempt === 0) {
            attempt += 1

            request.onToolCallStart?.({
              abortSignal: request.signal,
              experimental_context: undefined,
              functionId: undefined,
              messages: request.messages,
              metadata: undefined,
              model: undefined,
              stepNumber: 0,
              toolCall: {
                input: { command: 'pwd' },
                toolCallId: 'tool-bash-1',
                toolName: 'bash'
              }
            } as never)

            markToolExecutionStarted?.()
            markToolExecutionStarted = null

            await new Promise<void>((resolve) => {
              releaseToolExecution = resolve
            })

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
                content: [{ type: 'text', text: '/tmp/workspace\n' }],
                details: {
                  command: 'pwd',
                  cwd: '/tmp/workspace',
                  exitCode: 0,
                  stderr: '',
                  stdout: '/tmp/workspace\n'
                },
                metadata: {
                  cwd: '/tmp/workspace',
                  exitCode: 0
                }
              },
              toolCall: {
                input: { command: 'pwd' },
                toolCallId: 'tool-bash-1',
                toolName: 'bash'
              }
            } as never)

            // Stream ends naturally — hasPendingSteer picks up the steer
            return
          }

          yield 'Steered'
          yield ' reply'
        }
      })
    }
  )
})
