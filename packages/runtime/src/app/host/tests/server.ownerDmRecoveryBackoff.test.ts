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
import type { UserDocument, YachiyoServerEvent } from '@yachiyo/shared/protocol'

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

function createServerEventWaiter(server: YachiyoServer): {
  close: () => void
  waitForEvent: <TType extends YachiyoServerEvent['type']>(
    type: TType,
    predicate?: (event: Extract<YachiyoServerEvent, { type: TType }>) => boolean
  ) => Promise<Extract<YachiyoServerEvent, { type: TType }>>
} {
  const seenEvents = new Map<string, unknown[]>()
  const waiters = new Map<
    string,
    Array<{
      id: number
      predicate: (event: unknown) => boolean
      resolve: (event: unknown) => void
    }>
  >()
  let nextWaiterId = 0

  const unsubscribe = server.subscribe((event) => {
    const queue = waiters.get(event.type)
    if (!queue || queue.length === 0) {
      const seen = seenEvents.get(event.type) ?? []
      seen.push(event)
      seenEvents.set(event.type, seen)
      return
    }

    for (const waiter of [...queue]) {
      if (!waiter.predicate(event)) {
        continue
      }

      const nextQueue = (waiters.get(event.type) ?? []).filter((entry) => entry.id !== waiter.id)
      if (nextQueue.length === 0) {
        waiters.delete(event.type)
      } else {
        waiters.set(event.type, nextQueue)
      }
      waiter.resolve(event)
      return
    }

    const seen = seenEvents.get(event.type) ?? []
    seen.push(event)
    seenEvents.set(event.type, seen)
  })

  return {
    close: unsubscribe,
    waitForEvent: <TType extends YachiyoServerEvent['type']>(
      type: TType,
      predicate: (event: Extract<YachiyoServerEvent, { type: TType }>) => boolean = () => true
    ): Promise<Extract<YachiyoServerEvent, { type: TType }>> => {
      const seen = seenEvents.get(type) ?? []
      const index = seen.findIndex((event) =>
        predicate(event as Extract<YachiyoServerEvent, { type: TType }>)
      )
      if (index >= 0) {
        const [event] = seen.splice(index, 1)
        return Promise.resolve(event as Extract<YachiyoServerEvent, { type: TType }>)
      }

      return new Promise((resolve) => {
        const queue = waiters.get(type) ?? []
        queue.push({
          id: nextWaiterId++,
          predicate: (event) => predicate(event as Extract<YachiyoServerEvent, { type: TType }>),
          resolve: (event) => resolve(event as Extract<YachiyoServerEvent, { type: TType }>)
        })
        waiters.set(type, queue)
      })
    }
  }
}

test('YachiyoServer recovery-backoff cancellation preserves the existing head when head updates are disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-recovery-cancel-head-test-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(settingsPath, '[toolModel]\nmode = "disabled"\n', 'utf8')
  const userDocumentPath = join(root, '.yachiyo', 'USER.md')
  const workspacePathForThread = (threadId: string): string =>
    join(root, '.yachiyo', 'temp-workspace', threadId)
  const storage = createInMemoryYachiyoStorage()
  const createdAt = '2026-03-16T09:00:00.000Z'
  const interruptedAt = '2026-03-17T09:30:00.000Z'

  try {
    await mkdir(workspacePathForThread('thread-1'), { recursive: true })

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
          content: 'Resume but keep the current branch head.',
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
    storage.upsertRunRecoveryCheckpoint({
      runId: 'run-1',
      threadId: 'thread-1',
      requestMessageId: 'user-1',
      assistantMessageId: 'assistant-recovery-1',
      content: 'Recovered prefix. ',
      enabledTools: ['read', 'write', 'edit', 'bash', 'grep', 'glob', 'webRead', 'webSearch'],
      runTrigger: 'local',
      updateHeadOnComplete: false,
      createdAt,
      updatedAt: interruptedAt,
      recoveryAttempts: 1,
      lastError: 'net::ERR_CONNECTION_CLOSED'
    })

    const resumedServer = new YachiyoServer({
      storage,
      settingsPath,
      now: () => new Date(interruptedAt),
      readSoulDocument: async () => null,
      readUserDocument: () => readUserDocument({ filePath: userDocumentPath }),
      saveUserDocument: (content) => writeUserDocument({ filePath: userDocumentPath, content }),
      ensureThreadWorkspace: async (threadId) => {
        const workspacePath = workspacePathForThread(threadId)
        await mkdir(workspacePath, { recursive: true })
        return workspacePath
      },
      createModelRuntime: () => ({
        streamReply(): AsyncIterable<string> {
          const iterator: AsyncIterator<string> & AsyncIterable<string> = {
            next() {
              return Promise.reject(
                new RetryableRunError('temporary upstream failure', {
                  cause: Object.assign(new Error('temporary upstream failure'), { status: 500 })
                })
              )
            },
            [Symbol.asyncIterator]() {
              return iterator
            }
          }
          return iterator
        }
      })
    })
    const waiter = createServerEventWaiter(resumedServer)

    await resumedServer.upsertProvider({
      name: 'work',
      type: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
      modelList: {
        enabled: ['gpt-5'],
        disabled: []
      }
    })

    try {
      await resumedServer.bootstrap()
      await waiter.waitForEvent('run.retrying', (event) => event.runId === 'run-1')
      await resumedServer.cancelRun({ runId: 'run-1' })
      await waiter.waitForEvent('run.cancelled', (event) => event.runId === 'run-1')

      const bootstrap = await resumedServer.bootstrap()
      const stoppedMessage = (bootstrap.messagesByThread['thread-1'] ?? []).find(
        (message) => message.role === 'assistant' && message.status === 'stopped'
      )
      const persistedThread = bootstrap.threads.find((thread) => thread.id === 'thread-1')

      assert.ok(stoppedMessage)
      assert.equal(stoppedMessage?.id, 'assistant-recovery-1')
      assert.equal(persistedThread?.headMessageId, 'user-1')
    } finally {
      waiter.close()
      await resumedServer.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('YachiyoServer points the thread head at the retried request immediately', async () => {
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
        content: 'First question'
      })
      await completeRun(accepted.runId)

      let bootstrap = await server.bootstrap()
      const [userMessage, assistantMessage] = bootstrap.messagesByThread[thread.id] ?? []

      assert.equal(bootstrap.threads[0]?.headMessageId, assistantMessage?.id)

      const retried = await server.retryMessage({
        threadId: thread.id,
        messageId: assistantMessage!.id
      })

      bootstrap = await server.bootstrap()
      assert.equal(retried.requestMessageId, userMessage?.id)
      assert.equal(bootstrap.threads[0]?.headMessageId, userMessage?.id)

      await completeRun(retried.runId)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(): AsyncIterable<string> {
          attempt += 1

          if (attempt === 1) {
            yield 'First answer'
            return
          }

          await new Promise((resolve) => setTimeout(resolve, 10))
          yield 'Retried answer'
        }
      })
    }
  )
})

test('YachiyoServer gives owner DM threads the same turn budget as local threads', async () => {
  await withServer(async ({ server, completeRun, modelRequests }) => {
    const owner = server.createChannelUser({
      id: 'tg-owner-1',
      platform: 'telegram',
      externalUserId: '123',
      username: 'owner',
      label: '',
      status: 'allowed',
      role: 'owner',
      usageLimitKTokens: null,
      workspacePath: '/tmp/tg-owner'
    })

    const localThread = await server.createThread()
    const ownerDmThread = await server.createThread({
      source: 'telegram',
      channelUserId: owner.id,
      title: 'Telegram:@owner'
    })

    const localAccepted = await server.sendChat({
      threadId: localThread.id,
      content: 'Use the local turn budget.'
    })
    await completeRun(localAccepted.runId)

    const ownerAccepted = await server.sendChat({
      threadId: ownerDmThread.id,
      content: 'Use the owner DM turn budget.',
      channelHint: '<channel_reply_instruction>Use reply.</channel_reply_instruction>'
    })
    await completeRun(ownerAccepted.runId)

    const chatRequests = modelRequests.filter((request) => request.purpose === 'chat')
    const localRequest = chatRequests.find((request) =>
      request.messages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('Use the local turn budget.')
      )
    )
    const ownerRequest = chatRequests.find((request) =>
      request.messages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('Use the owner DM turn budget.')
      )
    )

    assert.equal(localRequest?.maxToolSteps, 999)
    assert.equal(ownerRequest?.maxToolSteps, localRequest?.maxToolSteps)
  })
})

test('YachiyoServer lists only owner-visible threads for owner DM takeover', async () => {
  await withServer(async ({ server }) => {
    const owner = server.createChannelUser({
      id: 'tg-owner-1',
      platform: 'telegram',
      externalUserId: '123',
      username: 'owner',
      label: '',
      status: 'allowed',
      role: 'owner',
      usageLimitKTokens: null,
      workspacePath: '/tmp/tg-owner'
    })
    const guest = server.createChannelUser({
      id: 'tg-guest-1',
      platform: 'telegram',
      externalUserId: '456',
      username: 'guest',
      label: '',
      status: 'allowed',
      role: 'guest',
      usageLimitKTokens: null,
      workspacePath: '/tmp/tg-guest'
    })

    let localThread = await server.createThread({ title: 'Local work' })
    localThread = await server.setThreadIcon({ threadId: localThread.id, icon: '🛠️' })
    const localNewChatThread = await server.createThread()
    const ownerDmThread = await server.createThread({
      source: 'telegram',
      channelUserId: owner.id,
      title: 'Owner DM'
    })
    const ownerNewChatThread = await server.createThread({
      source: 'telegram',
      channelUserId: owner.id
    })
    const guestDmThread = await server.createThread({
      source: 'telegram',
      channelUserId: guest.id,
      title: 'Guest DM'
    })
    const groupThread = await server.createThread({
      source: 'telegram',
      channelGroupId: 'telegram-group-1',
      title: 'Group'
    })

    const candidates = server.listOwnerDmTakeoverThreads({
      channelUserId: owner.id,
      limit: 10
    })
    const candidateIds = candidates.map((thread) => thread.id)

    assert.ok(candidateIds.includes(localThread.id))
    assert.ok(candidateIds.includes(ownerDmThread.id))
    assert.equal(candidateIds.includes(localNewChatThread.id), false)
    assert.equal(candidateIds.includes(ownerNewChatThread.id), false)
    assert.equal(candidateIds.includes(guestDmThread.id), false)
    assert.equal(candidateIds.includes(groupThread.id), false)
  })
})

test('YachiyoServer lists owner DM takeover candidates without full bootstrap', async () => {
  await withServer(async ({ server, storage }) => {
    const owner = server.createChannelUser({
      id: 'tg-owner-1',
      platform: 'telegram',
      externalUserId: '123',
      username: 'owner',
      label: '',
      status: 'allowed',
      role: 'owner',
      usageLimitKTokens: null,
      workspacePath: '/tmp/tg-owner'
    })
    const thread = await server.createThread({ title: 'Local work' })
    const bootstrap = storage.bootstrap
    storage.bootstrap = () => {
      throw new Error('listOwnerDmTakeoverThreads should not load full bootstrap state')
    }

    try {
      const candidates = server.listOwnerDmTakeoverThreads({
        channelUserId: owner.id,
        limit: 10
      })

      assert.ok(candidates.some((candidate) => candidate.id === thread.id))
    } finally {
      storage.bootstrap = bootstrap
    }
  })
})

test('YachiyoServer takes over a local thread for the owner DM channel', async () => {
  await withServer(async ({ server }) => {
    const owner = server.createChannelUser({
      id: 'tg-owner-1',
      platform: 'telegram',
      externalUserId: '123',
      username: 'owner',
      label: '',
      status: 'allowed',
      role: 'owner',
      usageLimitKTokens: null,
      workspacePath: '/tmp/tg-owner'
    })
    let thread = await server.createThread({ title: 'Fix DM reply ordering' })
    thread = await server.setThreadIcon({ threadId: thread.id, icon: '🛠️' })

    const updated = await server.takeOverThreadForChannelUser({
      threadId: thread.id,
      channelUser: owner
    })
    const active = server.findActiveChannelThread(owner.id, 60_000)

    assert.equal(updated.id, thread.id)
    assert.equal(updated.source, undefined)
    assert.equal(updated.channelUserId, owner.id)
    assert.equal(updated.channelUserRole, 'owner')
    assert.equal(active?.id, thread.id)
  })
})

test('YachiyoServer compacts an owner DM thread into a new active owner DM handoff thread', async () => {
  await withServer(async ({ server, completeRun, modelRequests, workspacePathForThread }) => {
    const owner = server.createChannelUser({
      id: 'tg-owner-handoff',
      platform: 'telegram',
      externalUserId: '123',
      username: 'owner',
      label: '',
      status: 'allowed',
      role: 'owner',
      usageLimitKTokens: null,
      workspacePath: '/tmp/tg-owner'
    })
    const ownerWorkspace = workspacePathForThread('explicit-owner-dm-workspace')
    const sourceThread = await server.createThread({
      source: 'telegram',
      channelUserId: owner.id,
      workspacePath: ownerWorkspace
    })
    const sourceAccepted = await server.sendChat({
      threadId: sourceThread.id,
      content: 'Prepare this owner DM handoff.'
    })
    await completeRun(sourceAccepted.runId)

    const compacted = await server.compactChannelThreadForChannelUser({
      threadId: sourceThread.id,
      channelUser: owner
    })
    await completeRun(compacted.runId)

    const handoffThread = server.findActiveChannelThread(owner.id, 60_000)
    const handoffMessages = server.loadThreadData(compacted.thread.id).messages

    assert.equal(compacted.sourceThreadId, sourceThread.id)
    assert.equal(compacted.thread.handoffFromThreadId, sourceThread.id)
    assert.equal(compacted.thread.source, 'telegram')
    assert.equal(compacted.thread.channelUserId, owner.id)
    assert.equal(compacted.thread.channelUserRole, 'owner')
    assert.equal(compacted.thread.workspacePath, ownerWorkspace)
    assert.equal(handoffThread?.id, compacted.thread.id)
    assert.equal(handoffMessages.at(-1)?.role, 'assistant')
    assert.equal(handoffMessages.at(-1)?.content, 'Hello world')
    assert.equal(
      modelRequests.some((request) => request.purpose === 'thread-handoff'),
      true
    )
    assert.notEqual(compacted.thread.workspacePath, workspacePathForThread(sourceThread.id))
  })
})

test('YachiyoServer rejects owner DM handoff for a different channel user', async () => {
  await withServer(async ({ server }) => {
    const owner = server.createChannelUser({
      id: 'tg-owner-handoff',
      platform: 'telegram',
      externalUserId: '123',
      username: 'owner',
      label: '',
      status: 'allowed',
      role: 'owner',
      usageLimitKTokens: null,
      workspacePath: '/tmp/tg-owner'
    })
    const otherOwner = server.createChannelUser({
      id: 'tg-owner-other',
      platform: 'telegram',
      externalUserId: '456',
      username: 'other',
      label: '',
      status: 'allowed',
      role: 'owner',
      usageLimitKTokens: null,
      workspacePath: '/tmp/tg-other'
    })
    const sourceThread = await server.createThread({
      source: 'telegram',
      channelUserId: owner.id
    })

    await assert.rejects(
      server.compactChannelThreadForChannelUser({
        threadId: sourceThread.id,
        channelUser: otherOwner
      }),
      /This conversation does not belong to this owner DM\./
    )
  })
})

test('YachiyoServer gates local-only tools for took-over owner DM threads by run trigger', async () => {
  await withServer(async ({ server, completeRun, modelRequests }) => {
    const owner = server.createChannelUser({
      id: 'tg-owner-1',
      platform: 'telegram',
      externalUserId: '123',
      username: 'owner',
      label: '',
      status: 'allowed',
      role: 'owner',
      usageLimitKTokens: null,
      workspacePath: '/tmp/tg-owner'
    })
    const thread = await server.takeOverThreadForChannelUser({
      threadId: (await server.createThread({ title: 'Fix DM reply ordering' })).id,
      channelUser: owner
    })

    const localAccepted = await server.sendChat({
      threadId: thread.id,
      content: 'Continue locally after takeover.'
    })
    await completeRun(localAccepted.runId)

    const channelAccepted = await server.sendChat({
      threadId: thread.id,
      content: 'Continue from Telegram after takeover.',
      channelHint: '<channel_reply_instruction>Use reply.</channel_reply_instruction>',
      extraTools: { reply: {} },
      runTrigger: 'channel'
    })
    await completeRun(channelAccepted.runId)

    const localRequest = modelRequests.find((request) =>
      request.messages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('Continue locally after takeover.')
      )
    )
    const channelRequest = modelRequests.find((request) =>
      request.messages.some(
        (message) =>
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.includes('Continue from Telegram after takeover.')
      )
    )

    assert.equal(Boolean(localRequest?.tools?.askUser), true)
    assert.equal(Boolean(channelRequest?.tools?.askUser), false)
    assert.equal(Boolean(channelRequest?.tools?.reply), true)
  })
})

test('YachiyoServer clears stale recap text when an external channel run starts', async () => {
  await withServer(async ({ server, storage }) => {
    const owner = server.createChannelUser({
      id: 'tg-owner-1',
      platform: 'telegram',
      externalUserId: '123',
      username: 'owner',
      label: '',
      status: 'allowed',
      role: 'owner',
      usageLimitKTokens: null,
      workspacePath: '/tmp/tg-owner'
    })
    const thread = await server.createThread({
      source: 'telegram',
      channelUserId: owner.id,
      title: 'Owner DM'
    })
    storage.updateThread({
      ...thread,
      recapText: 'Old recap that should disappear when the owner replies from IM.'
    })

    await server.sendChat({
      threadId: thread.id,
      content: 'Continue from Telegram.',
      channelHint: '<channel_reply_instruction>Use reply.</channel_reply_instruction>'
    })

    const updatedThread = (await server.bootstrap()).threads.find(
      (candidate) => candidate.id === thread.id
    )
    assert.ok(updatedThread)
    assert.equal(updatedThread.recapText, undefined)
  })
})

test('YachiyoServer builds owner DM takeover context from recap, visible delta, and tool calls', async () => {
  await withServer(async ({ server, storage, completeRun }) => {
    let thread = await server.createThread({ title: 'Fix DM reply ordering' })
    thread = await server.setThreadIcon({ threadId: thread.id, icon: '🛠️' })
    const firstAccepted = await server.sendChat({
      threadId: thread.id,
      content: 'First request before recap.'
    })
    await completeRun(firstAccepted.runId)

    let bootstrap = await server.bootstrap()
    const firstAssistant = (bootstrap.messagesByThread[thread.id] ?? []).find(
      (message) => message.role === 'assistant'
    )
    assert.ok(firstAssistant)
    const afterFirstRunThread = bootstrap.threads.find((candidate) => candidate.id === thread.id)
    assert.ok(afterFirstRunThread)
    storage.updateThread({
      ...afterFirstRunThread,
      contextHandoffSummary:
        'Earlier recap: the reply ordering issue was narrowed to outbound delivery.',
      contextHandoffWatermarkMessageId: firstAssistant.id
    })

    const secondAccepted = await server.sendChat({
      threadId: thread.id,
      content: 'Fix the duplicated reply after normal text.'
    })
    await completeRun(secondAccepted.runId)

    bootstrap = await server.bootstrap()
    const messages = bootstrap.messagesByThread[thread.id] ?? []
    const secondUser = messages.find(
      (message) => message.role === 'user' && message.content.includes('duplicated reply')
    )
    const secondAssistant = messages.find(
      (message) => message.role === 'assistant' && message.parentMessageId === secondUser?.id
    )
    assert.ok(secondUser)
    assert.ok(secondAssistant)

    storage.createToolCall({
      id: 'tool-1',
      threadId: thread.id,
      requestMessageId: secondUser.id,
      assistantMessageId: secondAssistant.id,
      toolName: 'bash',
      status: 'completed',
      inputSummary: 'pnpm test directMessageService',
      outputSummary: '19 tests passed',
      startedAt: '2026-03-31T00:00:03.000Z',
      finishedAt: '2026-03-31T00:00:04.000Z'
    })

    const context = server.buildThreadTakeoverContext({
      threadId: thread.id,
      contextTokenLimit: 100_000
    })

    assert.match(context, /^Took over:\n🛠️ Fix DM reply ordering/)
    assert.match(context, /\n---\n\nLast recap:/)
    assert.match(context, /Last recap:/)
    assert.match(context, /Earlier recap: the reply ordering issue/)
    assert.match(context, /\n---\n\nSince then:/)
    assert.match(context, /User: Fix the duplicated reply after normal text\./)
    assert.match(context, /Assistant: Hello world/)
    assert.match(context, /\n---\n\nRecent tool activity:/)
    assert.match(context, /- bash pnpm test directMessageService — completed/)
    assert.match(context, /\n---\n\nWorkspace:/)
    assert.match(context, /\nContext:/)
    assert.equal(context.includes('19 tests passed'), false)
  })
})
