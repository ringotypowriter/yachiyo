import assert from 'node:assert/strict'
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

test('YachiyoServer allows changing a fresh handoff thread workspace before the first user continuation', async () => {
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

      const inheritedWorkspace = join(tmpdir(), 'yachiyo-handoff-inherited-workspace')
      const sourceThread = await server.createThread({
        workspacePath: inheritedWorkspace
      })
      const sourceAccepted = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Prepare a handoff.'
      })
      await completeRun(sourceAccepted.runId)

      const compacted = await server.compactThreadToAnotherThread({
        threadId: sourceThread.id
      })
      await completeRun(compacted.runId)

      const replacementWorkspace = join(tmpdir(), 'yachiyo-handoff-replacement-workspace')
      const updatedThread = await server.updateThreadWorkspace({
        threadId: compacted.thread.id,
        workspacePath: replacementWorkspace
      })
      assert.equal(updatedThread.workspacePath, replacementWorkspace)

      const continuation = await server.sendChat({
        threadId: compacted.thread.id,
        content: 'Continue from the handoff.'
      })
      await completeRun(continuation.runId)

      await assert.rejects(
        server.updateThreadWorkspace({
          threadId: compacted.thread.id,
          workspacePath: inheritedWorkspace
        }),
        /already has conversation history/
      )

      const confirmedThread = await server.updateThreadWorkspace({
        threadId: compacted.thread.id,
        workspacePath: inheritedWorkspace,
        confirmed: true
      })
      assert.equal(confirmedThread.workspacePath, inheritedWorkspace)
    },
    {
      createModelRuntime: () => ({
        async *streamReply(request: ModelStreamRequest): AsyncIterable<string> {
          const lastMessage = request.messages.at(-1)
          const lastMessageText =
            typeof lastMessage?.content === 'string' ? lastMessage.content : ''

          if (/visible handoff/i.test(lastMessageText)) {
            yield 'Visible handoff'
            return
          }

          yield 'Hello world'
        }
      })
    }
  )
})

test('YachiyoServer blocks compact-to-another-thread while the source thread is running', async () => {
  await withServer(async ({ server }) => {
    const thread = await server.createThread()
    await server.sendChat({
      threadId: thread.id,
      content: 'Keep working on this for a moment.'
    })

    await assert.rejects(
      () =>
        server.compactThreadToAnotherThread({
          threadId: thread.id
        }),
      /Cannot compact a thread with an active run\./
    )

    const bootstrap = await server.bootstrap()
    assert.equal(bootstrap.threads.length, 1)
    assert.equal(bootstrap.threads[0]?.id, thread.id)
  })
})

test('YachiyoServer rejects handoff for external threads', async () => {
  await withServer(async ({ server }) => {
    const thread = await server.createThread({
      source: 'telegram',
      channelUserId: 'tg-user-1',
      title: 'Telegram:@alice'
    })

    await assert.rejects(() =>
      server.compactThreadToAnotherThread({
        threadId: thread.id
      })
    )
  })
})

test('YachiyoServer rejects handoff creation when source temp workspace setup fails', async () => {
  let failingThreadId: string | null = null

  await withServer(
    async ({ server, completeRun }) => {
      const sourceThread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Prepare a handoff with a failing source workspace.'
      })
      await completeRun(accepted.runId)

      failingThreadId = sourceThread.id
      await assert.rejects(
        server.compactThreadToAnotherThread({
          threadId: sourceThread.id
        }),
        /source workspace failed/
      )

      failingThreadId = null
      const retry = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Continue after the failed handoff.'
      })

      assert.equal(retry.kind, 'run-started')
      await completeRun(retry.runId)
    },
    {
      ensureThreadWorkspace: async (threadId, workspacePathForThread) => {
        if (threadId === failingThreadId) {
          throw new Error('source workspace failed')
        }

        const workspacePath = workspacePathForThread(threadId)
        await mkdir(workspacePath, { recursive: true })
        return workspacePath
      }
    }
  )
})

test('YachiyoServer clearChannelGroupHistory resets every hidden group probe thread in place', async () => {
  await withServer(async ({ server, storage }) => {
    const group = server.createChannelGroup({
      id: 'group-1',
      platform: 'telegram',
      externalGroupId: 'telegram-group-1',
      name: 'Test Group',
      label: 'Test Group',
      status: 'approved',
      workspacePath: '/tmp/group-workspace'
    })
    const otherGroup = server.createChannelGroup({
      id: 'group-2',
      platform: 'telegram',
      externalGroupId: 'telegram-group-2',
      name: 'Other Group',
      label: 'Other Group',
      status: 'approved',
      workspacePath: '/tmp/other-group-workspace'
    })

    const hiddenThread = await server.createThread({
      source: 'telegram',
      channelGroupId: group.id,
      workspacePath: group.workspacePath,
      title: `${group.name} [group probe]`
    })
    const hiddenThread2 = await server.createThread({
      source: 'telegram',
      channelGroupId: group.id,
      workspacePath: group.workspacePath,
      title: `${group.name} [group probe 2]`
    })
    const untouchedThread = await server.createThread({
      source: 'telegram',
      channelGroupId: otherGroup.id,
      workspacePath: otherGroup.workspacePath,
      title: `${otherGroup.name} [group probe]`
    })

    const hiddenThreadMessage = {
      id: 'group-1-message',
      threadId: hiddenThread.id,
      role: 'assistant' as const,
      content: 'Hidden group probe history',
      hidden: true,
      status: 'completed' as const,
      createdAt: '2026-04-21T00:00:00.000Z'
    }
    const hiddenThread2Message = {
      id: 'group-1-message-2',
      threadId: hiddenThread2.id,
      role: 'assistant' as const,
      content: 'More hidden group probe history',
      hidden: true,
      status: 'completed' as const,
      createdAt: '2026-04-21T00:01:00.000Z'
    }
    const untouchedMessage = {
      id: 'group-2-message',
      threadId: untouchedThread.id,
      role: 'assistant' as const,
      content: 'Other group history',
      hidden: true,
      status: 'completed' as const,
      createdAt: '2026-04-21T00:02:00.000Z'
    }

    storage.saveThreadMessage({
      thread: hiddenThread,
      updatedThread: {
        ...hiddenThread,
        headMessageId: hiddenThreadMessage.id,
        preview: hiddenThreadMessage.content,
        updatedAt: hiddenThreadMessage.createdAt
      },
      message: hiddenThreadMessage
    })
    storage.saveThreadMessage({
      thread: hiddenThread2,
      updatedThread: {
        ...hiddenThread2,
        headMessageId: hiddenThread2Message.id,
        preview: hiddenThread2Message.content,
        updatedAt: hiddenThread2Message.createdAt
      },
      message: hiddenThread2Message
    })
    storage.saveThreadMessage({
      thread: untouchedThread,
      updatedThread: {
        ...untouchedThread,
        headMessageId: untouchedMessage.id,
        preview: untouchedMessage.content,
        updatedAt: untouchedMessage.createdAt
      },
      message: untouchedMessage
    })

    storage.saveGroupMonitorBuffer({
      groupId: group.id,
      phase: 'active',
      buffer: [
        {
          senderName: 'Alice',
          senderExternalUserId: 'user-1',
          isMention: false,
          text: 'hello',
          timestamp: Date.now() / 1_000
        }
      ],
      savedAt: new Date().toISOString()
    })

    await server.clearChannelGroupHistory({ groupId: group.id })

    assert.equal(storage.loadGroupMonitorBuffer(group.id), undefined)
    assert.equal(
      server.findActiveGroupThread(group.id, 7 * 24 * 60 * 60 * 1_000)?.id,
      hiddenThread.id
    )
    assert.equal(storage.getThread(hiddenThread.id)?.headMessageId, undefined)
    assert.equal(storage.getThread(hiddenThread2.id)?.headMessageId, undefined)
    assert.deepEqual(storage.listThreadMessages(hiddenThread.id), [])
    assert.deepEqual(storage.listThreadMessages(hiddenThread2.id), [])
    assert.deepEqual(storage.listThreadRuns(hiddenThread.id), [])
    assert.deepEqual(storage.listThreadRuns(hiddenThread2.id), [])
    assert.deepEqual(storage.listThreadToolCalls(hiddenThread.id), [])
    assert.deepEqual(storage.listThreadToolCalls(hiddenThread2.id), [])
    assert.equal(storage.getThread(untouchedThread.id)?.headMessageId, untouchedMessage.id)
    assert.deepEqual(storage.listThreadMessages(untouchedThread.id), [untouchedMessage])
  })
})

test('YachiyoServer starts channel group history clear in the background and emits lifecycle events', async () => {
  await withServer(async ({ server, storage, waitForEvent }) => {
    const group = server.createChannelGroup({
      id: 'group-clear-1',
      platform: 'telegram',
      externalGroupId: 'telegram-group-clear-1',
      name: 'Clear Group',
      label: 'Clear Group',
      status: 'approved',
      workspacePath: '/tmp/group-clear-workspace'
    })

    const hiddenThread = await server.createThread({
      source: 'telegram',
      channelGroupId: group.id,
      workspacePath: group.workspacePath,
      title: `${group.name} [group probe]`
    })

    storage.saveThreadMessage({
      thread: hiddenThread,
      updatedThread: {
        ...hiddenThread,
        headMessageId: 'clear-hidden-message',
        preview: 'Hidden group probe history',
        updatedAt: '2026-04-21T00:00:00.000Z'
      },
      message: {
        id: 'clear-hidden-message',
        threadId: hiddenThread.id,
        role: 'assistant',
        content: 'Hidden group probe history',
        hidden: true,
        status: 'completed',
        createdAt: '2026-04-21T00:00:00.000Z'
      }
    })

    let resetCalls = 0
    const originalReset = storage.resetThreadsHistory
    storage.resetThreadsHistory = ((input) => {
      resetCalls++
      originalReset(input)
    }) as typeof storage.resetThreadsHistory

    server.startClearChannelGroupHistory({ groupId: group.id })

    const started = (await waitForEvent('channel-group-history-clear.started')) as {
      groupId: string
    }
    assert.equal(started.groupId, group.id)
    assert.equal(resetCalls, 0)
    assert.equal(storage.getThread(hiddenThread.id)?.headMessageId, 'clear-hidden-message')

    await new Promise((resolve) => setTimeout(resolve, 0))

    const completed = (await waitForEvent('channel-group-history-clear.completed')) as {
      groupId: string
    }
    assert.equal(completed.groupId, group.id)
    assert.equal(resetCalls, 1)
    assert.equal(storage.getThread(hiddenThread.id)?.headMessageId, undefined)
    assert.deepEqual(storage.listThreadMessages(hiddenThread.id), [])
  })
})

test('YachiyoServer background clear does not wipe post-clear group probe traffic', async () => {
  await withServer(async ({ server, storage, waitForEvent }) => {
    const group = server.createChannelGroup({
      id: 'group-clear-2',
      platform: 'telegram',
      externalGroupId: 'telegram-group-clear-2',
      name: 'Clear Group Two',
      label: 'Clear Group Two',
      status: 'approved',
      workspacePath: '/tmp/group-clear-workspace-2'
    })

    const oldThread = await server.createThread({
      source: 'telegram',
      channelGroupId: group.id,
      workspacePath: group.workspacePath,
      title: `${group.name} [group probe]`
    })

    storage.saveThreadMessage({
      thread: oldThread,
      updatedThread: {
        ...oldThread,
        headMessageId: 'old-hidden-message',
        preview: 'Old hidden history',
        updatedAt: '2026-04-21T00:00:00.000Z'
      },
      message: {
        id: 'old-hidden-message',
        threadId: oldThread.id,
        role: 'assistant',
        content: 'Old hidden history',
        hidden: true,
        status: 'completed',
        createdAt: '2026-04-21T00:00:00.000Z'
      }
    })

    server.startClearChannelGroupHistory({ groupId: group.id })
    await waitForEvent('channel-group-history-clear.started')

    const freshThread = await server.createThread({
      source: 'telegram',
      channelGroupId: group.id,
      workspacePath: group.workspacePath,
      title: `${group.name} [group probe after clear]`
    })

    storage.saveThreadMessage({
      thread: freshThread,
      updatedThread: {
        ...freshThread,
        headMessageId: 'fresh-hidden-message',
        preview: 'Fresh hidden history',
        updatedAt: '2026-04-21T00:01:00.000Z'
      },
      message: {
        id: 'fresh-hidden-message',
        threadId: freshThread.id,
        role: 'assistant',
        content: 'Fresh hidden history',
        hidden: true,
        status: 'completed',
        createdAt: '2026-04-21T00:01:00.000Z'
      }
    })

    await waitForEvent('channel-group-history-clear.completed')

    assert.deepEqual(storage.listThreadMessages(oldThread.id), [])
    assert.deepEqual(storage.listThreadMessages(freshThread.id), [
      {
        id: 'fresh-hidden-message',
        threadId: freshThread.id,
        role: 'assistant',
        content: 'Fresh hidden history',
        hidden: true,
        status: 'completed',
        createdAt: '2026-04-21T00:01:00.000Z'
      }
    ])
  })
})

test('YachiyoServer compact handoff reuses the implicit source workspace without cloning', async () => {
  await withServer(
    async ({ server, completeRun, workspacePathForThread }) => {
      const sourceThread = await server.createThread()
      const accepted = await server.sendChat({
        threadId: sourceThread.id,
        content: 'Keep this workspace when compacting.'
      })
      await completeRun(accepted.runId)

      const compacted = await server.compactThreadToAnotherThread({
        threadId: sourceThread.id
      })
      await completeRun(compacted.runId)

      const bootstrap = await server.bootstrap()
      assert.equal(bootstrap.threads.length, 2)
      assert.equal(
        bootstrap.threads.some((thread) => thread.id === sourceThread.id),
        true
      )
      assert.equal(compacted.thread.workspacePath, workspacePathForThread(sourceThread.id))
    },
    {
      cloneThreadWorkspace: async () => {
        throw new Error('workspace clone failed')
      }
    }
  )
})

test('YachiyoServer bootstrap creates the default USER.md template under the same .yachiyo root', async () => {
  await withServer(async ({ server }) => {
    await server.bootstrap()

    const document = await server.getUserDocument()
    const content = await readFile(document.filePath, 'utf8')

    assert.equal(document.filePath.includes('/.yachiyo/USER.md'), true)
    assert.match(content, /^# USER/m)
  })
})

test('YachiyoServer persists direct USER.md edits through the settings-facing API', async () => {
  await withServer(async ({ server }) => {
    const saved = await server.saveUserDocument({
      content: '# USER\n\n## Preferences\n- Prefers concise collaboration'
    })

    assert.equal(saved.filePath.includes('/.yachiyo/USER.md'), true)
    // saveUserDocument writes raw content; getUserDocument may migrate freeform to tables
    const onDisk = await readFile(saved.filePath, 'utf8')
    assert.match(onDisk, /# USER/)
    assert.match(onDisk, /Preferences/)
    assert.match(onDisk, /concise collaboration/)
  })
})
