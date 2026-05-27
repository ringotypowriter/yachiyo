import assert from 'node:assert/strict'
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { YachiyoServer } from '../YachiyoServer.ts'
import { RetryableRunError } from '../../../runtime/models/runtimeErrors.ts'
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

test('YachiyoServer persists assistant text blocks around tool calls', async () => {
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
        content: 'Split the assistant message around tools'
      })

      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const assistantMessage = bootstrap.messagesByThread[thread.id]?.find(
        (message) => message.role === 'assistant'
      )

      assert.deepEqual(
        assistantMessage?.textBlocks?.map((textBlock) => textBlock.content),
        ['Before tool', 'After tool']
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          yield 'Before tool'

          request.onToolCallStart?.({
            abortSignal: request.signal,
            experimental_context: undefined,
            functionId: undefined,
            messages: request.messages,
            metadata: undefined,
            model: undefined,
            stepNumber: 0,
            toolCall: {
              input: { filePath: '/tmp/example.txt' },
              toolCallId: 'tool-read-1',
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
              content: [{ type: 'text', text: 'ok' }],
              details: {
                path: '/tmp/example.txt',
                startLine: 1,
                endLine: 1,
                totalLines: 1,
                totalBytes: 2,
                truncated: false
              },
              metadata: {}
            },
            toolCall: {
              input: { filePath: '/tmp/example.txt' },
              toolCallId: 'tool-read-1',
              toolName: 'read'
            }
          } as never)

          yield 'After tool'
        }
      })
    }
  )
})

test('YachiyoServer applies steer at the completed tool-call boundary', async () => {
  const requests: ModelStreamRequest[] = []
  let attempt = 0
  let firstRequest: ModelStreamRequest | null = null
  const toolUpdates: Array<{ assistantMessageId?: string; status: string }> = []
  let releaseToolExecution: (() => void) | null = null
  let markToolExecutionStarted: (() => void) | null = null
  const toolExecutionStarted = new Promise<void>((resolve) => {
    markToolExecutionStarted = resolve
  })
  let markSteerQueued: (() => void) | null = null
  const steerQueued = new Promise<void>((resolve) => {
    markSteerQueued = resolve
  })

  await withServer(
    async ({ server, completeRun }) => {
      const unsubscribe = server.subscribe((event) => {
        if (event.type !== 'tool.updated') {
          return
        }

        if (event.runId !== acceptedRunId) {
          return
        }

        toolUpdates.push({
          ...(event.toolCall.assistantMessageId
            ? { assistantMessageId: event.toolCall.assistantMessageId }
            : {}),
          status: event.toolCall.status
        })
      })
      let acceptedRunId = ''

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
      acceptedRunId = accepted.runId

      await toolExecutionStarted

      const steerAccepted = await server.sendChat({
        threadId: thread.id,
        content: 'Actually summarize the result instead',
        mode: 'steer'
      })
      const beforeRelease = await server.bootstrap()

      assert.equal(steerAccepted.kind, 'active-run-steer-pending')
      assert.equal(firstRequest?.signal.aborted, false)
      assert.equal(requests.length, 1)
      assert.equal((beforeRelease.messagesByThread[thread.id] ?? []).length, 1)

      markSteerQueued!()
      releaseToolExecution?.()
      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const messages = bootstrap.messagesByThread[thread.id] ?? []
      const toolCalls = bootstrap.toolCallsByThread[thread.id] ?? []

      assert.equal(firstRequest?.signal.aborted, false)
      assert.equal(requests.length, 2)
      assert.ok(
        requests[1]?.messages.some(
          (message) =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) => part.type === 'text' && part.text === 'Checking the workspace'
            )
        ),
        'continuation prompt should keep the completed assistant turn'
      )
      assert.ok(
        requests[1]?.messages.some(
          (message) =>
            message.role === 'tool' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) => part.type === 'tool-result' && part.toolCallId === 'tool-bash-1'
            )
        ),
        'continuation prompt should keep the tool result'
      )
      assert.equal(requests[1]?.messages.at(-1)?.role, 'user')
      assert.ok(
        String(requests[1]?.messages.at(-1)?.content).startsWith(
          'Actually summarize the result instead'
        )
      )
      assert.equal(toolCalls.length, 1)
      assert.equal(toolCalls[0]?.status, 'completed')
      assert.equal(toolCalls[0]?.outputSummary, 'exit 0')
      assert.equal(toolCalls[0]?.error, undefined)
      assert.deepEqual(
        toolUpdates.map((toolCall) => toolCall.status),
        ['running', 'completed', 'completed']
      )
      const completedAssistant = messages.find(
        (message) =>
          message.role === 'assistant' &&
          message.status === 'completed' &&
          message.content === 'Checking the workspace'
      )
      const steerMessage = messages.find(
        (message) =>
          message.role === 'user' && message.content === 'Actually summarize the result instead'
      )
      const finalAssistant = messages.find(
        (message) => message.role === 'assistant' && message.content === 'Steered reply'
      )

      assert.equal(messages[0]?.content, 'List the workspace files.')
      assert.ok(completedAssistant)
      assert.ok(steerMessage)
      assert.ok(finalAssistant)
      assert.equal(steerMessage?.parentMessageId, completedAssistant?.id)
      assert.equal(finalAssistant?.parentMessageId, steerMessage?.id)
      assert.equal(toolUpdates[0]?.assistantMessageId, undefined)
      assert.equal(toolUpdates[1]?.assistantMessageId, undefined)
      assert.equal(toolUpdates[2]?.assistantMessageId, completedAssistant?.id)
      unsubscribe()
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (attempt === 0) {
            attempt += 1
            firstRequest = request

            yield 'Checking the workspace'

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

            await steerQueued

            const stopWhen = request.stopWhen
            assert.ok(stopWhen, 'steer-aware stopWhen should be passed into the tool loop')
            const stopConditions = Array.isArray(stopWhen) ? stopWhen : [stopWhen]
            const shouldStop = (
              await Promise.all(
                stopConditions.map((condition) =>
                  condition({
                    steps: [
                      {
                        toolCalls: [{ toolCallId: 'tool-bash-1', toolName: 'bash' }],
                        toolResults: [{ toolCallId: 'tool-bash-1', toolName: 'bash' }]
                      } as never
                    ]
                  })
                )
              )
            ).some(Boolean)

            if (shouldStop) {
              return
            }

            yield ' but this should have been cut before the steer'
            return
          }

          yield 'Steered'
          yield ' reply'
        }
      })
    }
  )
})

test('YachiyoServer recovers a committed transport failure and resumes from preserved tool history', async () => {
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
        content: 'Inspect the workspace and finish the answer.'
      })
      assertAcceptedHasUserMessage(accepted)

      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const messages = bootstrap.messagesByThread[thread.id] ?? []
      const toolCalls = bootstrap.toolCallsByThread[thread.id] ?? []
      const finalAssistant = messages.find(
        (message) =>
          message.role === 'assistant' && message.parentMessageId === accepted.userMessage.id
      )

      assert.equal(requests.length, 2)
      assert.ok(
        requests[1]?.messages.some(
          (message) =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) => part.type === 'text' && part.text === 'Checking the workspace. '
            )
        ),
        'recovery prompt should keep the partial assistant text'
      )
      assert.ok(
        requests[1]?.messages.some(
          (message) =>
            message.role === 'tool' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) => part.type === 'tool-result' && part.toolCallId === 'tool-bash-recover-1'
            )
        ),
        'recovery prompt should keep the completed tool result'
      )
      assert.equal(requests[1]?.messages.at(-1)?.role, 'user')
      assert.ok(
        String(requests[1]?.messages.at(-1)?.content).includes(
          'The previous assistant response was interrupted by a recoverable transport failure.'
        )
      )
      assert.equal(toolCalls.length, 1)
      assert.equal(toolCalls[0]?.status, 'completed')
      assert.equal(toolCalls[0]?.outputSummary, 'exit 0')
      assert.equal(finalAssistant?.content, 'Checking the workspace. Final answer.')
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (attempt === 0) {
            attempt += 1

            yield 'Checking the workspace. '

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
                toolCallId: 'tool-bash-recover-1',
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
                toolCallId: 'tool-bash-recover-1',
                toolName: 'bash'
              }
            } as never)

            const cause = Object.assign(new Error('net::ERR_CONNECTION_CLOSED'), { status: 0 })
            throw new RetryableRunError('net::ERR_CONNECTION_CLOSED', { cause })
          }

          yield 'Final answer.'
        }
      })
    }
  )
})

test('YachiyoServer preserves fresh continuation text when a recovered run does not replay the prefix', async () => {
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
        content: 'Continue from the saved work without repeating it.'
      })
      assertAcceptedHasUserMessage(accepted)

      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const finalAssistant = (bootstrap.messagesByThread[thread.id] ?? []).find(
        (message) =>
          message.role === 'assistant' && message.parentMessageId === accepted.userMessage.id
      )

      assert.equal(
        finalAssistant?.content,
        'Checking the workspace. Continuing from the saved work.'
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply() {
          if (attempt === 0) {
            attempt += 1
            yield 'Checking the workspace. '

            const cause = Object.assign(new Error('net::ERR_CONNECTION_CLOSED'), { status: 0 })
            throw new RetryableRunError('net::ERR_CONNECTION_CLOSED', { cause })
          }

          yield 'C'
          yield 'ontinuing from the saved work.'
        }
      })
    }
  )
})
