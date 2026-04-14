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

test('cancelling a run during tool execution preserves the tool call in bootstrap', async () => {
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
        content: 'Run something'
      })

      await toolStartedPromise

      // Cancel while tool is still running (no steer — plain cancel)
      await server.cancelRun({ runId: accepted.runId })
      await completeRun(accepted.runId)

      const result = await bootstrap()
      const messages = result.messagesByThread[thread.id] ?? []
      const toolCalls = result.toolCallsByThread[thread.id] ?? []

      // The stopped assistant message should exist
      const stoppedAssistant = messages.find(
        (m) => m.role === 'assistant' && m.status === 'stopped'
      )
      assert.ok(stoppedAssistant, 'stopped assistant message should be persisted')

      // The tool call should still be present and bound to the stopped message
      assert.ok(toolCalls.length > 0, 'tool call should be preserved after cancel')
      const toolCall = toolCalls.find((tc) => tc.id === 'tool-bash-cancel')
      assert.ok(toolCall, 'the specific tool call should exist')
      assert.equal(toolCall.status, 'failed', 'tool call should be marked failed')
      assert.equal(
        toolCall.assistantMessageId,
        stoppedAssistant.id,
        'tool call should be bound to the stopped assistant message'
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          yield 'Starting...'
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
              toolCallId: 'tool-bash-cancel',
              toolName: 'bash'
            }
          } as never)

          toolStarted?.()

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
        }
      })
    }
  )
})

test('cancelling a run with a pending steer persists the steer but does not restart', async () => {
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

      // Cancel is honored — the run does NOT restart, so no completed assistant reply
      // to the steer exists. The user can re-send or start a new run.
      const completedAssistant = messages.find(
        (m) =>
          m.role === 'assistant' &&
          m.status === 'completed' &&
          m.parentMessageId === steerMessage?.id
      )
      assert.ok(!completedAssistant, 'cancel should not restart the run')
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
          }
        })
      })()
    }
  )
})

test('deleting the final reply after steer keeps earlier tool calls bound to the stopped assistant', async () => {
  let attempt = 0
  let markFirstAttemptReady: (() => void) | null = null
  const firstAttemptReady = new Promise<void>((resolve) => {
    markFirstAttemptReady = resolve
  })
  let markSteerQueued: (() => void) | null = null
  const steerQueued = new Promise<void>((resolve) => {
    markSteerQueued = resolve
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

      await firstAttemptReady

      await server.sendChat({
        threadId: thread.id,
        content: 'Be more concise',
        mode: 'steer'
      })

      // Signal the mock that the steer has been queued so it can finish
      markSteerQueued!()

      await completeRun(accepted.runId)

      const bootstrapBeforeDelete = await bootstrap()
      const messagesBeforeDelete = bootstrapBeforeDelete.messagesByThread[thread.id] ?? []
      const assistants = messagesBeforeDelete.filter(
        (m) => m.role === 'assistant' && m.status === 'completed'
      )
      assert.ok(assistants.length >= 2, 'should have at least two completed assistants')
      // The first completed assistant is the pre-steer response (with tool calls),
      // the second is the post-steer response.
      const stoppedAssistant = assistants.find((m) => m.content.includes('Checking workspace'))
      const finalAssistant = assistants.find((m) => m.content === 'Concise')
      assert.ok(stoppedAssistant, 'should have pre-steer assistant')
      assert.ok(finalAssistant, 'should have post-steer assistant')

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

            markFirstAttemptReady?.()
            markFirstAttemptReady = null

            // Wait for the steer to be queued by the test, then finish
            // the stream naturally so hasPendingSteer triggers.
            await steerQueued
            return
          }

          yield 'Concise'
        }
      })
    }
  )
})
