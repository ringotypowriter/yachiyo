import assert from 'node:assert/strict'
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import type { UserDocument } from '../../../../../shared/yachiyo/protocol.ts'

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

    await server.setThreadIcon({ threadId: thread.id, icon: '🌊' })

    const branched = await server.createBranch({
      threadId: thread.id,
      messageId: retriedAssistant!.id
    })

    assert.equal(branched.thread.icon, '🌊')
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
              content: [{ type: 'text', text: 'hello' }],
              details: {
                endLine: 1,
                path: `/tmp/notes-${runAttempt}.txt`,
                startLine: 1,
                totalBytes: 5,
                totalLines: 1,
                truncated: false
              },
              metadata: {}
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

test('YachiyoServer creates a branch while the source thread has an active run', async () => {
  let requestCount = 0
  let releaseActiveRun: (() => void) | null = null

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
      const firstRun = await server.sendChat({
        threadId: thread.id,
        content: 'Seed this branch'
      })
      await completeRun(firstRun.runId)

      const sourceWorkspacePath = workspacePathForThread(thread.id)
      const stableFilePath = join(sourceWorkspacePath, 'notes.txt')
      await mkdir(sourceWorkspacePath, { recursive: true })
      await writeFile(stableFilePath, 'before active run', 'utf8')

      const secondRun = await server.sendChat({
        threadId: thread.id,
        content: 'Keep running'
      })

      for (let attempt = 0; attempt < 50 && !releaseActiveRun; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      const release = releaseActiveRun
      assert.ok(release, 'active run should reach the model stream before branching')

      try {
        const bootstrap = await server.bootstrap()
        const firstAssistant = bootstrap.messagesByThread[thread.id]?.find(
          (message) => message.role === 'assistant'
        )
        assert.ok(firstAssistant)

        const branch = await server.createBranch({
          threadId: thread.id,
          messageId: firstAssistant.id
        })

        assert.equal(branch.thread.branchFromThreadId, thread.id)
        assert.equal(branch.thread.branchFromMessageId, firstAssistant.id)
        assert.deepEqual(
          branch.messages.map((message) => message.content),
          ['Seed this branch', 'Seed answer']
        )

        const branchWorkspacePath = workspacePathForThread(branch.thread.id)
        assert.equal(
          await readFile(join(branchWorkspacePath, 'notes.txt'), 'utf8'),
          'before active run'
        )
        await assert.rejects(access(join(branchWorkspacePath, 'during-run.txt')))
      } finally {
        release()
        await completeRun(secondRun.runId)
      }
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest): AsyncIterable<string> {
          requestCount += 1
          if (requestCount === 1) {
            yield 'Seed answer'
            return
          }

          yield 'Active answer'
          const tools = request.tools as
            | Record<
                string,
                {
                  execute: (
                    input: unknown,
                    options?: { abortSignal?: AbortSignal }
                  ) => Promise<unknown>
                }
              >
            | undefined
          if (!tools?.read || !tools.write) {
            throw new Error('Expected read and write tools')
          }

          await tools.read.execute({ path: 'notes.txt' }, { abortSignal: request.signal })
          await tools.write.execute(
            { path: 'notes.txt', content: 'during active run' },
            { abortSignal: request.signal }
          )
          await tools.write.execute(
            { path: 'during-run.txt', content: 'created during active run' },
            { abortSignal: request.signal }
          )

          await new Promise<void>((resolve) => {
            releaseActiveRun = resolve
          })
          yield ' done'
        }
      })
    }
  )
})

test('YachiyoServer keeps active-run reply workspace changes when branching from that reply', async () => {
  let requestCount = 0
  let finishFirstLeg: (() => void) | null = null
  let finishSecondLeg: (() => void) | null = null

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
      const sourceWorkspacePath = workspacePathForThread(thread.id)
      await mkdir(sourceWorkspacePath, { recursive: true })
      await writeFile(join(sourceWorkspacePath, 'notes.txt'), 'before active run', 'utf8')

      const activeRun = await server.sendChat({
        threadId: thread.id,
        content: 'Produce active reply'
      })

      for (let attempt = 0; attempt < 50 && !finishFirstLeg; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      const releaseFirst = finishFirstLeg
      assert.ok(releaseFirst, 'first active run leg should reach the model stream')

      await server.sendChat({
        threadId: thread.id,
        content: 'Continue this same run',
        mode: 'steer'
      })
      releaseFirst()

      for (let attempt = 0; attempt < 50 && !finishSecondLeg; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      const releaseSecond = finishSecondLeg
      assert.ok(releaseSecond, 'second active run leg should keep the run active')

      try {
        const bootstrap = await server.bootstrap()
        const activeAssistant = bootstrap.messagesByThread[thread.id]?.find(
          (message) => message.role === 'assistant' && message.content === 'Active answer'
        )
        assert.ok(activeAssistant)

        const branch = await server.createBranch({
          threadId: thread.id,
          messageId: activeAssistant.id
        })

        assert.deepEqual(
          branch.messages.map((message) => message.content),
          ['Produce active reply', 'Active answer']
        )

        const branchWorkspacePath = workspacePathForThread(branch.thread.id)
        assert.equal(
          await readFile(join(branchWorkspacePath, 'notes.txt'), 'utf8'),
          'during active run'
        )
        assert.equal(
          await readFile(join(branchWorkspacePath, 'during-run.txt'), 'utf8'),
          'created during active run'
        )
        await assert.rejects(access(join(branchWorkspacePath, 'later-run.txt')))
      } finally {
        releaseSecond()
        await completeRun(activeRun.runId)
      }
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest): AsyncIterable<string> {
          requestCount += 1

          if (requestCount === 1) {
            yield 'Active answer'
            const tools = request.tools as
              | Record<
                  string,
                  {
                    execute: (
                      input: unknown,
                      options?: { abortSignal?: AbortSignal }
                    ) => Promise<unknown>
                  }
                >
              | undefined
            if (!tools?.read || !tools.write) {
              throw new Error('Expected read and write tools')
            }

            await tools.read.execute({ path: 'notes.txt' }, { abortSignal: request.signal })
            await tools.write.execute(
              { path: 'notes.txt', content: 'during active run' },
              { abortSignal: request.signal }
            )
            await tools.write.execute(
              { path: 'during-run.txt', content: 'created during active run' },
              { abortSignal: request.signal }
            )

            await new Promise<void>((resolve) => {
              finishFirstLeg = resolve
            })
            return
          }

          const tools = request.tools as
            | Record<
                string,
                {
                  execute: (
                    input: unknown,
                    options?: { abortSignal?: AbortSignal }
                  ) => Promise<unknown>
                }
              >
            | undefined
          if (!tools?.read || !tools.write) {
            throw new Error('Expected read and write tools')
          }

          await tools.read.execute({ path: 'notes.txt' }, { abortSignal: request.signal })
          await tools.write.execute(
            { path: 'notes.txt', content: 'later active run' },
            { abortSignal: request.signal }
          )
          await tools.write.execute(
            { path: 'later-run.txt', content: 'created by later active run' },
            { abortSignal: request.signal }
          )

          await new Promise<void>((resolve) => {
            finishSecondLeg = resolve
          })
          yield ' done'
        }
      })
    }
  )
})

test('YachiyoServer allows changing a fresh branch workspace before the first new message', async () => {
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
        content: 'Branch this thread'
      })
      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const assistantMessage = bootstrap.messagesByThread[thread.id]?.[1]
      const branch = await server.createBranch({
        threadId: thread.id,
        messageId: assistantMessage!.id
      })

      const customWorkspace = join(tmpdir(), 'yachiyo-branch-custom-workspace')
      const updatedBranch = await server.updateThreadWorkspace({
        threadId: branch.thread.id,
        workspacePath: customWorkspace
      })
      assert.equal(updatedBranch.workspacePath, customWorkspace)

      const followUp = await server.sendChat({
        threadId: branch.thread.id,
        content: 'Now continue on the branch'
      })
      await completeRun(followUp.runId)

      await assert.rejects(
        server.updateThreadWorkspace({
          threadId: branch.thread.id,
          workspacePath: null
        }),
        /before the first message is sent/
      )
    },
    {
      createModelRuntime: () => ({
        async *streamReply(): AsyncIterable<string> {
          yield 'Done'
        }
      })
    }
  )
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

test('YachiyoServer recovers retry branches that only produced tool calls', async () => {
  let runAttempt = 0
  const requests: ModelStreamRequest[] = []

  await withServer(
    async ({ server, completeRun }) => {
      const thread = await server.createThread()

      const firstRun = await server.sendChat({
        threadId: thread.id,
        content: 'Question'
      })
      await completeRun(firstRun.runId)

      let bootstrap = await server.bootstrap()
      const [userMessage, firstAssistant] = bootstrap.messagesByThread[thread.id] ?? []

      const recoveredRetryRun = await server.retryMessage({
        threadId: thread.id,
        messageId: firstAssistant!.id
      })
      await completeRun(recoveredRetryRun.runId)

      bootstrap = await server.bootstrap()

      const recoveredRetryAssistant = (bootstrap.messagesByThread[thread.id] ?? []).find(
        (message) =>
          message.parentMessageId === userMessage?.id &&
          message.role === 'assistant' &&
          message.status === 'completed' &&
          message.id !== firstAssistant?.id
      )
      const recoveredRetryToolCalls = (bootstrap.toolCallsByThread[thread.id] ?? []).filter(
        (toolCall) => toolCall.runId === recoveredRetryRun.runId
      )

      assert.ok(
        requests[2]?.messages.some(
          (message) =>
            message.role === 'assistant' &&
            Array.isArray(message.content) &&
            message.content.some(
              (part) =>
                part.type === 'tool-call' &&
                part.toolCallId === 'tool-retry-failed-1' &&
                'input' in part &&
                typeof part.input === 'object' &&
                part.input !== null &&
                'path' in part.input &&
                part.input.path === '/tmp/notes.txt'
            )
        )
      )
      assert.ok(recoveredRetryAssistant)
      assert.equal(recoveredRetryAssistant?.content, 'Recovered answer')
      assert.deepEqual(
        recoveredRetryToolCalls.map((toolCall) => toolCall.assistantMessageId),
        [recoveredRetryAssistant?.id]
      )

      const switched = await server.selectReplyBranch({
        threadId: thread.id,
        assistantMessageId: recoveredRetryAssistant!.id
      })

      assert.equal(switched.headMessageId, recoveredRetryAssistant?.id)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest): AsyncIterable<string> {
          requests.push(request)
          runAttempt += 1

          if (runAttempt === 1) {
            yield 'Original answer'
            return
          }

          if (runAttempt === 2) {
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
                toolCallId: 'tool-retry-failed-1',
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
                content: [{ type: 'text', text: 'hello' }],
                details: {
                  endLine: 1,
                  path: '/tmp/notes.txt',
                  startLine: 1,
                  totalBytes: 5,
                  totalLines: 1,
                  truncated: false
                },
                metadata: {}
              },
              toolCall: {
                input: { path: 'notes.txt' },
                toolCallId: 'tool-retry-failed-1',
                toolName: 'read'
              }
            } as never)

            throw new RetryableRunError('Tool-backed retry failure')
          }

          yield 'Recovered answer'
        }
      })
    }
  )
})
