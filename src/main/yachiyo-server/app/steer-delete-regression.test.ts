import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { YachiyoServer } from './YachiyoServer.ts'
import type { ModelStreamRequest } from '../runtime/types.ts'
import { createInMemoryYachiyoStorage } from '../storage/memoryStorage.ts'
import { readUserDocument, writeUserDocument } from '../runtime/user.ts'

async function withServer(
  fn: (input: {
    server: YachiyoServer
    completeRun: (runId: string) => Promise<void>
    bootstrap: () => ReturnType<YachiyoServer['bootstrap']>
  }) => Promise<void>,
  options: {
    createModelRuntime?: () => {
      streamReply(request: ModelStreamRequest): AsyncIterable<string>
    }
  } = {}
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-test-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(settingsPath, '[toolModel]\nmode = "disabled"\n', 'utf8')
  const userDocumentPath = join(root, '.yachiyo', 'USER.md')
  const storage = createInMemoryYachiyoStorage()

  const seenEvents = new Map<string, unknown[]>()

  const settle = (type: string, value: unknown): void => {
    const seen = seenEvents.get(type) ?? []
    seen.push(value)
    seenEvents.set(type, seen)
  }

  const takeSeenEvent = <T>(type: string, predicate: (value: T) => boolean): T | undefined => {
    const queue = seenEvents.get(type) as T[] | undefined
    if (!queue || queue.length === 0) return undefined
    const index = queue.findIndex(predicate)
    if (index < 0) return undefined
    return queue.splice(index, 1)[0] as T
  }

  const server = new YachiyoServer({
    storage,
    settingsPath,
    ensureThreadWorkspace: async (threadId) => {
      const workspacePath = join(root, '.yachiyo', 'temp-workspace', threadId)
      await mkdir(workspacePath, { recursive: true })
      return workspacePath
    },
    createModelRuntime:
      options.createModelRuntime ??
      (() => ({
        async *streamReply() {
          yield 'Hello'
          yield ' world'
        }
      })),
    readSoulDocument: async () => null,
    readUserDocument: () => readUserDocument({ filePath: userDocumentPath }),
    saveUserDocument: (content) => writeUserDocument({ filePath: userDocumentPath, content })
  })

  const unsubscribe = server.subscribe((event) => settle(event.type, event))

  const completeRun = (runId: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const completed = takeSeenEvent<{ runId: string }>('run.completed', (e) => e.runId === runId)
      if (completed) return resolve()
      const failed = takeSeenEvent<{ runId: string; error: string }>(
        'run.failed',
        (e) => e.runId === runId
      )
      if (failed) return reject(new Error(failed.error))
      const cancelled = takeSeenEvent<{ runId: string }>('run.cancelled', (e) => e.runId === runId)
      if (cancelled) return resolve()

      const unsub = server.subscribe((event) => {
        if (event.type === 'run.completed' && (event as { runId: string }).runId === runId) {
          unsub()
          resolve()
        } else if (event.type === 'run.failed' && (event as { runId: string }).runId === runId) {
          unsub()
          reject(new Error((event as { error: string }).error))
        } else if (event.type === 'run.cancelled' && (event as { runId: string }).runId === runId) {
          unsub()
          resolve()
        }
      })
    })

  try {
    await fn({ server, completeRun, bootstrap: () => server.bootstrap() })
  } finally {
    unsubscribe()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}

test('cancelling a run with a pending steer persists the steer and restarts the run', async () => {
  let toolStarted: (() => void) | null = null
  const toolStartedPromise = new Promise<void>((resolve) => {
    toolStarted = resolve
  })

  await withServer(
    async ({ server, completeRun, bootstrap }) => {
      await server.upsertProvider({
        name: 'default',
        type: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        modelList: { enabled: ['gpt-5'], disabled: [] }
      })

      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Run a slow command'
      })

      // Wait until the tool call has started so the steer becomes pending
      await toolStartedPromise

      // Send a steer while tool is running — this queues as pendingSteerInput
      const steerResult = await server.sendChat({
        threadId: thread.id,
        content: 'Actually do something else',
        mode: 'steer'
      })
      assert.equal(steerResult.kind, 'active-run-steer-pending')

      // Now the user cancels the run while the steer is still pending
      await server.cancelRun({ runId: accepted.runId })
      await completeRun(accepted.runId)

      const bootstrapResult = await bootstrap()
      const messages = bootstrapResult.messagesByThread[thread.id] ?? []

      // The steer message should have been persisted, not dropped
      const steerMessage = messages.find(
        (m) => m.role === 'user' && m.content === 'Actually do something else'
      )
      assert.ok(steerMessage, 'pending steer message should be persisted when run is cancelled')

      // The run should have restarted and produced a response to the steer
      const finalAssistant = messages.find(
        (m) => m.role === 'assistant' && m.status === 'completed'
      )
      assert.ok(finalAssistant, 'run should restart and complete with the steer message')
    },
    {
      createModelRuntime: (() => {
        let attempt = 0
        return () => ({
          async *streamReply(request: ModelStreamRequest) {
            if (attempt === 0) {
              attempt += 1
              yield 'Running command...'

              // Simulate a long-running tool call
              request.onToolCallStart?.({
                abortSignal: request.signal,
                experimental_context: undefined,
                functionId: undefined,
                messages: request.messages,
                metadata: undefined,
                model: undefined,
                stepNumber: 0,
                toolCall: {
                  input: { command: 'sleep 60' },
                  toolCallId: 'tool-bash-slow',
                  toolName: 'bash'
                }
              } as never)

              toolStarted?.()

              // Block until aborted (simulates long-running tool)
              await new Promise<void>((_, reject) => {
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

            // Second attempt: respond to the steer
            yield 'OK, doing something else instead.'
          }
        })
      })()
    }
  )
})

test('deleting the final reply after steer keeps earlier tool calls bound to the stopped assistant', async () => {
  let attempt = 0
  let markFirstAttemptAtAbortWait: (() => void) | null = null
  const firstAttemptAtAbortWait = new Promise<void>((resolve) => {
    markFirstAttemptAtAbortWait = resolve
  })

  await withServer(
    async ({ server, completeRun, bootstrap }) => {
      await server.upsertProvider({
        name: 'default',
        type: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        modelList: { enabled: ['gpt-5'], disabled: [] }
      })

      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Check files'
      })

      await firstAttemptAtAbortWait

      await server.sendChat({
        threadId: thread.id,
        content: 'Be more concise',
        mode: 'steer'
      })

      await completeRun(accepted.runId)

      const bootstrapBeforeDelete = await bootstrap()
      const messagesBeforeDelete = bootstrapBeforeDelete.messagesByThread[thread.id] ?? []
      const stoppedAssistant = messagesBeforeDelete.find(
        (m) => m.role === 'assistant' && m.status === 'stopped'
      )
      const finalAssistant = messagesBeforeDelete.find(
        (m) => m.role === 'assistant' && m.status === 'completed'
      )
      assert.ok(stoppedAssistant, 'should have stopped assistant')
      assert.ok(finalAssistant, 'should have final assistant')

      const toolCallsBeforeDelete = bootstrapBeforeDelete.toolCallsByThread[thread.id] ?? []
      const stoppedToolCall = toolCallsBeforeDelete.find(
        (tc) => tc.assistantMessageId === stoppedAssistant!.id
      )
      assert.ok(stoppedToolCall, 'tool call should be bound to stopped assistant')

      await server.deleteMessageFromHere({
        threadId: thread.id,
        messageId: finalAssistant.id
      })

      const bootstrapAfterDelete = await bootstrap()
      const messagesAfterDelete = bootstrapAfterDelete.messagesByThread[thread.id] ?? []
      const toolCallsAfterDelete = bootstrapAfterDelete.toolCallsByThread[thread.id] ?? []

      assert.ok(
        messagesAfterDelete.some((m) => m.id === stoppedAssistant!.id),
        'stopped assistant should still exist'
      )
      assert.ok(
        !messagesAfterDelete.some((m) => m.id === finalAssistant!.id),
        'final assistant should be deleted'
      )
      assert.ok(
        toolCallsAfterDelete.some((tc) => tc.id === stoppedToolCall!.id),
        'tool call bound to stopped assistant should be preserved'
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          if (attempt === 0) {
            attempt += 1
            yield 'Checking workspace'

            request.onToolCallStart?.({
              abortSignal: request.signal,
              experimental_context: undefined,
              functionId: undefined,
              messages: request.messages,
              metadata: undefined,
              model: undefined,
              stepNumber: 0,
              toolCall: {
                input: { command: 'ls' },
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
                content: [{ type: 'text', text: 'file1.txt\n' }],
                details: {
                  command: 'ls',
                  cwd: '/tmp',
                  exitCode: 0,
                  stderr: '',
                  stdout: 'file1.txt\n'
                },
                metadata: {
                  cwd: '/tmp',
                  exitCode: 0
                }
              },
              toolCall: {
                input: { command: 'ls' },
                toolCallId: 'tool-bash-1',
                toolName: 'bash'
              }
            } as never)

            yield ' Here is the result'

            markFirstAttemptAtAbortWait?.()
            markFirstAttemptAtAbortWait = null

            await new Promise<void>((_, reject) => {
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

          yield 'Concise'
        }
      })
    }
  )
})
