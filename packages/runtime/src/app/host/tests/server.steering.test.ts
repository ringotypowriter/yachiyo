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

test('YachiyoServer debounces duplicate steer requests while a run is generating', async () => {
  const requests: ModelStreamRequest[] = []
  let now = new Date('2026-04-05T00:00:00.000Z')
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
        name: 'default',
        type: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        modelList: { enabled: ['gpt-5'], disabled: [] }
      })

      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Start here'
      })

      await ready

      now = new Date('2026-04-05T00:00:00.500Z')
      const firstSteer = await server.sendChat({
        threadId: thread.id,
        content: 'Use this instead',
        mode: 'steer'
      })
      const duplicateSteer = await server.sendChat({
        threadId: thread.id,
        content: 'Use this instead',
        mode: 'steer'
      })

      assert.equal(firstSteer.kind, 'active-run-steer-pending')
      assert.equal(duplicateSteer.kind, 'active-run-steer-pending')
      assert.equal(firstSteer.runId, duplicateSteer.runId)

      markSteerQueued!()
      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      assert.deepEqual(
        (bootstrap.messagesByThread[thread.id] ?? [])
          .filter((message) => message.role === 'user')
          .map((message) => message.content),
        ['Start here', 'Use this instead']
      )
      assert.equal(requests.length, 2)
    },
    {
      now: () => now,
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

test('multiple steers during an active run are merged into a single pending steer message', async () => {
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
        name: 'default',
        type: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        modelList: { enabled: ['gpt-5'], disabled: [] }
      })

      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Start the run'
      })

      await ready

      const firstSteer = await server.sendChat({
        threadId: thread.id,
        content: 'line 1',
        mode: 'steer'
      })
      const secondSteer = await server.sendChat({
        threadId: thread.id,
        content: 'line 2',
        mode: 'steer'
      })

      assert.equal(firstSteer.kind, 'active-run-steer-pending')
      assert.equal(secondSteer.kind, 'active-run-steer-pending')
      assert.equal(firstSteer.runId, secondSteer.runId)

      markSteerQueued!()
      await completeRun(accepted.runId)

      const result = await server.bootstrap()
      const messages = result.messagesByThread[thread.id] ?? []
      const steerMessage = messages.find((m) => m.role === 'user' && m.content.includes('line 1'))
      assert.ok(steerMessage, 'merged steer message should exist')
      assert.equal(
        steerMessage.content,
        'line 1\nline 2',
        'steer contents should be merged with newline'
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
          yield 'Done'
        }
      })
    }
  )
})

test('withdrawing a pending steer restores the active run skill override before later turns', async () => {
  let attempt = 0
  let markReady: (() => void) | null = null
  const ready = new Promise<void>((resolve) => {
    markReady = resolve
  })
  let releaseFirstRun: (() => void) | null = null
  const firstRunReleased = new Promise<void>((resolve) => {
    releaseFirstRun = resolve
  })

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
        content: 'Start here',
        enabledTools: ['read']
      })

      await ready

      const steerAccepted = await server.sendChat({
        threadId: thread.id,
        content: 'Use the refactor skill',
        mode: 'steer',
        enabledSkillNames: ['workspace-refactor']
      })
      assert.equal(steerAccepted.kind, 'active-run-steer-pending')

      const beforeWithdraw = (
        server as unknown as {
          runDomain: {
            activeRuns: Map<
              string,
              {
                enabledSkillNames?: string[]
                pendingSteerInputs?: Array<{
                  previousEnabledSkillNames?: string[]
                }>
              }
            >
          }
        }
      ).runDomain.activeRuns.get(accepted.runId)
      assert.deepEqual(beforeWithdraw?.enabledSkillNames, ['workspace-refactor'])
      assert.equal(beforeWithdraw?.pendingSteerInputs?.[0]?.previousEnabledSkillNames, undefined)

      server.withdrawPendingSteer({ threadId: thread.id })

      const afterWithdraw = (
        server as unknown as {
          runDomain: {
            activeRuns: Map<
              string,
              {
                enabledSkillNames?: string[]
                pendingSteerInputs?: unknown
              }
            >
          }
        }
      ).runDomain.activeRuns.get(accepted.runId)
      assert.equal(afterWithdraw?.pendingSteerInputs, undefined)
      assert.equal(afterWithdraw?.enabledSkillNames, undefined)

      releaseFirstRun!()
      await completeRun(accepted.runId)
    },
    {
      createModelRuntime: () => ({
        async *streamReply() {
          attempt += 1

          if (attempt === 1) {
            markReady?.()
            await firstRunReleased
            yield 'Original reply'
            return
          }
        }
      })
    }
  )
})

test('steer after generation preserves full assistant content as a completed message', async () => {
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
        name: 'default',
        type: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        modelList: { enabled: ['gpt-5'], disabled: [] }
      })

      const thread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Tell me something long'
      })

      await ready

      const steerAccepted = await server.sendChat({
        threadId: thread.id,
        content: 'Never mind, do this instead',
        mode: 'steer'
      })

      markSteerQueued!()
      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const messages = bootstrap.messagesByThread[thread.id] ?? []

      assert.equal(steerAccepted.kind, 'active-run-steer-pending')

      const preSteerMsg = messages.find(
        (m) => m.role === 'assistant' && m.content === 'Here is the full answer'
      )
      assert.ok(preSteerMsg, 'pre-steer assistant message should exist')
      assert.equal(preSteerMsg.status, 'completed')
    },
    {
      createModelRuntime: () => ({
        async *streamReply() {
          if (attempt === 0) {
            attempt += 1
            yield 'Here is the full answer'
            markReady?.()
            await steerQueued
            return
          }
          yield 'New answer'
        }
      })
    }
  )
})

test('steer before any output does not emit a retrying state', async () => {
  let attempt = 0
  const retryEvents: Array<{ attempt: number; error: string }> = []
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
        name: 'default',
        type: 'openai',
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com/v1',
        modelList: { enabled: ['gpt-5'], disabled: [] }
      })

      const unsubscribe = server.subscribe((event) => {
        if (event.type !== 'run.retrying') {
          return
        }

        retryEvents.push({
          attempt: event.attempt,
          error: event.error
        })
      })

      try {
        const thread = await server.createThread()
        const accepted = await server.sendChat({
          threadId: thread.id,
          content: 'Start the run'
        })

        await ready

        const steerAccepted = await server.sendChat({
          threadId: thread.id,
          content: 'Do this instead',
          mode: 'steer'
        })

        markSteerQueued!()
        await completeRun(accepted.runId)

        const bootstrap = await server.bootstrap()
        const messages = bootstrap.messagesByThread[thread.id] ?? []

        assert.equal(steerAccepted.kind, 'active-run-steer-pending')
        assert.deepEqual(retryEvents, [])
        // Pre-steer assistant (empty but completed), steer user, post-steer assistant
        assert.ok(messages.length >= 3)
        assert.equal(messages[0]?.content, 'Start the run')
      } finally {
        unsubscribe()
      }
    },
    {
      createModelRuntime: () => {
        const current = attempt++
        return {
          async *streamReply() {
            if (current === 0) {
              // Yield minimal content so the run produces a non-empty response
              yield 'Initial response'
              markReady?.()
              await steerQueued
              return
            }

            yield 'Steered'
            yield ' reply'
          }
        }
      }
    }
  )
})

test('YachiyoServer continues with steer after runtime returns normally', async () => {
  const requests: ModelStreamRequest[] = []
  let attempt = 0
  let markFirstRunReady: (() => void) | null = null
  const firstRunReady = new Promise<void>((resolve) => {
    markFirstRunReady = resolve
  })
  let markSteerQueued: (() => void) | null = null
  const steerQueued = new Promise<void>((resolve) => {
    markSteerQueued = resolve
  })

  await withServer(
    async ({ server, completeRun, waitForEvent }) => {
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

      await waitForEvent('message.started')
      await firstRunReady

      const steerAccepted = await server.sendChat({
        threadId: thread.id,
        content: 'Use the screenshot instead',
        mode: 'steer'
      })

      markSteerQueued!()
      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      const messages = bootstrap.messagesByThread[thread.id] ?? []

      assert.equal(steerAccepted.kind, 'active-run-steer-pending')
      assert.equal(steerAccepted.runId, accepted.runId)
      // user request → completed assistant → steer user → steered assistant
      assert.equal(messages.length, 4)
      assert.equal(messages[0]?.content, 'Start with the code path')
      assert.equal(messages[1]?.role, 'assistant')
      assert.equal(messages[1]?.status, 'completed')
      assert.equal(messages[2]?.content, 'Use the screenshot instead')
      assert.equal(messages[2]?.parentMessageId, messages[1]?.id)
      assert.equal(messages[3]?.role, 'assistant')
      assert.equal(messages[3]?.content, 'Steered reply')
      assert.equal(messages[3]?.parentMessageId, messages[2]?.id)
      for (const [i, expected] of [
        'Start with the code path',
        'Use the screenshot instead'
      ].entries()) {
        assert.ok(
          String(requests[i]?.messages.at(-1)?.content).startsWith(expected),
          `request ${i} last message should start with "${expected}"`
        )
      }
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest) {
          requests.push(request)

          if (attempt === 0) {
            attempt += 1
            markFirstRunReady?.()
            markFirstRunReady = null
            await steerQueued
            yield 'Pre-steer reply'
            return
          }

          yield 'Steered'
          yield ' reply'
        }
      })
    }
  )
})
