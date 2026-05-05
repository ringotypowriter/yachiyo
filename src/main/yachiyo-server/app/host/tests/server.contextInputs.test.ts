import assert from 'node:assert/strict'
import { access, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import test from 'node:test'
import { YachiyoServer } from '../YachiyoServer.ts'
import type { ModelStreamRequest } from '../../../runtime/models/types.ts'
import type { SoulDocument } from '../../../runtime/profiles/soul.ts'
import { readUserDocument, writeUserDocument } from '../../../runtime/profiles/user.ts'
import { createInMemoryYachiyoStorage } from '../../../storage/memoryStorage.ts'
import type { MemoryService } from '../../../services/memory/memoryService.ts'
import { createJotdownStore } from '../../../services/jotdownStore.ts'
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

test('YachiyoServer injects only active skill summaries into runtime context and exposes skillsRead', async () => {
  await withServer(async ({ server, completeRun, modelRequests, workspacePathForThread }) => {
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
    const workspacePath = workspacePathForThread(thread.id)

    await mkdir(join(workspacePath, '.yachiyo', 'skills', 'workspace-refactor'), {
      recursive: true
    })
    await writeFile(
      join(workspacePath, '.yachiyo', 'skills', 'workspace-refactor', 'SKILL.md'),
      [
        '---',
        'name: workspace-refactor',
        'description: Workspace refactor guide',
        '---',
        '',
        '# Workspace Refactor',
        '',
        'Detailed implementation instructions.'
      ].join('\n')
    )

    await server.saveConfig({
      ...(await server.getConfig()),
      skills: {
        enabled: ['workspace-refactor']
      }
    })

    const accepted = await server.sendChat({
      threadId: thread.id,
      content: 'Use the local skill summary',
      enabledTools: ['read']
    })
    await completeRun(accepted.runId)

    const request = modelRequests.at(-1)
    assert.ok(request)
    assert.deepEqual(Object.keys(request.tools ?? {}), [
      'read',
      'write',
      'edit',
      'bash',
      'jsRepl',
      'webRead',
      'grep',
      'glob',
      'webSearch',
      'skillsRead',
      'searchMemory',
      'remember',
      'updateProfile',
      'askUser'
    ])
    assert.ok(
      request.messages.some(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.includes('workspace-refactor: Workspace refactor guide')
      )
    )
    assert.ok(
      !request.messages.some(
        (message) =>
          message.role === 'system' &&
          typeof message.content === 'string' &&
          message.content.includes('Detailed implementation instructions.')
      )
    )
  })
})

test('YachiyoServer keeps @file mentions visible in chat while injecting hidden file context for the model', async () => {
  await withServer(async ({ server, completeRun, modelRequests, workspacePathForThread }) => {
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
    const workspacePath = workspacePathForThread(thread.id)
    await mkdir(join(workspacePath, 'src'), { recursive: true })
    await writeFile(
      join(workspacePath, 'src', 'tiny.ts'),
      ['export const tiny = true', 'export const answer = 42'].join('\n'),
      'utf8'
    )

    const accepted = await server.sendChat({
      threadId: thread.id,
      content: 'Check @src/tiny.ts before changing it.'
    })
    await completeRun(accepted.runId)

    const bootstrap = await server.bootstrap()
    assert.equal(
      bootstrap.messagesByThread[thread.id]?.[0]?.content,
      'Check @src/tiny.ts before changing it.'
    )

    const request = modelRequests.at(-1)
    assert.ok(request)
    const lastContent = String(request.messages.at(-1)?.content ?? '')
    assert.match(lastContent, /<file_mentions>/)
    assert.match(lastContent, /<referenced_file path="src\/tiny\.ts">/)
    assert.match(lastContent, /Check @src\/tiny\.ts before changing it\./)
  })
})

test('YachiyoServer keeps @folder mentions visible in chat while injecting a shallow hidden directory listing for the model', async () => {
  await withServer(async ({ server, completeRun, modelRequests, workspacePathForThread }) => {
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
    const workspacePath = workspacePathForThread(thread.id)
    await mkdir(join(workspacePath, 'src', 'components', 'nested'), { recursive: true })
    await writeFile(
      join(workspacePath, 'src', 'components', 'Composer.tsx'),
      'export function Composer() { return null }\n',
      'utf8'
    )
    await writeFile(
      join(workspacePath, 'src', 'components', '.secret.ts'),
      'export const secret = true\n',
      'utf8'
    )
    await writeFile(
      join(workspacePath, 'src', 'components', 'nested', 'deep.ts'),
      'export const deep = true\n',
      'utf8'
    )

    const accepted = await server.sendChat({
      threadId: thread.id,
      content: 'Check @!src/components before changing it.'
    })
    await completeRun(accepted.runId)

    const bootstrap = await server.bootstrap()
    assert.equal(
      bootstrap.messagesByThread[thread.id]?.[0]?.content,
      'Check @!src/components before changing it.'
    )

    const request = modelRequests.at(-1)
    assert.ok(request)
    assert.match(String(request.messages.at(-1)?.content ?? ''), /<file_mentions>/)
    assert.match(
      String(request.messages.at(-1)?.content ?? ''),
      /<referenced_directory path="src\/components">/
    )
    assert.match(String(request.messages.at(-1)?.content ?? ''), /Composer\.tsx/)
    assert.match(String(request.messages.at(-1)?.content ?? ''), /\.secret\.ts/)
    assert.match(String(request.messages.at(-1)?.content ?? ''), /nested\//)
    assert.doesNotMatch(String(request.messages.at(-1)?.content ?? ''), /deep\.ts/)
    assert.match(
      String(request.messages.at(-1)?.content ?? ''),
      /Check @!src\/components before changing it\./
    )
  })
})

test('YachiyoServer resolves @JotDown to the latest jot down content regardless of workspace', async () => {
  await withServer(
    async ({ server, completeRun, modelRequests, workspacePathForThread }) => {
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
      // Ensure workspace exists so the thread has a workspace path
      await mkdir(workspacePathForThread(thread.id), { recursive: true })

      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Check @JotDown for my notes.'
      })
      await completeRun(accepted.runId)

      const bootstrap = await server.bootstrap()
      assert.equal(
        bootstrap.messagesByThread[thread.id]?.[0]?.content,
        'Check @JotDown for my notes.'
      )

      const request = modelRequests.at(-1)
      assert.ok(request)
      const lastContent = String(request.messages.at(-1)?.content ?? '')
      assert.match(lastContent, /<file_mentions>\n- @JotDown -> JotDown\n<\/file_mentions>/)
      assert.match(
        lastContent,
        /<referenced_jotdown path="~\/.yachiyo-jotdown-test-for-server\/2026-04-05_10-00-00\.md">/
      )
      assert.match(lastContent, /My latest jot down note/)
      assert.match(lastContent, /Check @JotDown for my notes\./)
    },
    {
      jotdownStore: (() => {
        const baseDir = join(homedir(), '.yachiyo-jotdown-test-for-server')
        const store = createJotdownStore(baseDir)
        // Pre-seed a note by writing directly and using the store
        return {
          ...store,
          baseDir,
          async getLatest() {
            return {
              id: '2026-04-05_10-00-00',
              title: 'Jotdown Test',
              content: 'My latest jot down note',
              createdAt: '2026-04-05T10:00:00',
              modifiedAt: '2026-04-05T10:00:00'
            }
          }
        } as import('../../../services/jotdownStore.ts').JotdownStore
      })()
    }
  )
})

test('YachiyoServer fails runs cleanly when thread workspace initialization fails', async () => {
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
        content: 'This run should fail before the model starts.'
      })

      await assert.rejects(completeRun(firstRun.runId), /Workspace initialization failed/)

      const secondRun = await server.sendChat({
        threadId: thread.id,
        content: 'This thread should not stay wedged as running.'
      })

      await assert.rejects(completeRun(secondRun.runId), /Workspace initialization failed/)

      const bootstrap = await server.bootstrap()
      assert.equal(bootstrap.messagesByThread[thread.id]?.length, 4)
      assert.deepEqual(
        (bootstrap.messagesByThread[thread.id] ?? []).map((message) => message.status),
        ['completed', 'failed', 'completed', 'failed']
      )
    },
    {
      ensureThreadWorkspace: async () => {
        throw new Error('Workspace unavailable')
      }
    }
  )
})

test('YachiyoServer allows setting a specific workspace before the first send and locks it after', async () => {
  await withServer(
    async ({ completeRun, server }) => {
      const firstWorkspace = join(tmpdir(), 'yachiyo-specific-workspace-a')
      const secondWorkspace = join(tmpdir(), 'yachiyo-specific-workspace-b')

      const thread = await server.createThread({
        workspacePath: firstWorkspace
      })
      assert.equal(thread.workspacePath, firstWorkspace)

      const updatedThread = await server.updateThreadWorkspace({
        threadId: thread.id,
        workspacePath: secondWorkspace
      })
      assert.equal(updatedThread.workspacePath, secondWorkspace)

      const accepted = await server.sendChat({
        threadId: thread.id,
        content: 'Hello'
      })
      await completeRun(accepted.runId)

      await assert.rejects(
        server.updateThreadWorkspace({
          threadId: thread.id,
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

test('YachiyoServer surfaces ignored workspace matches for the picker as @! candidates', async () => {
  await withServer(async ({ server, workspacePathForThread }) => {
    const thread = await server.createThread()
    const workspacePath = workspacePathForThread(thread.id)

    await mkdir(join(workspacePath, 'docs'), { recursive: true })
    await writeFile(join(workspacePath, '.gitignore'), 'docs/\n', 'utf8')
    await writeFile(join(workspacePath, 'docs', 'ACP_CAPABILITY_GAP.md'), '# Gap\n', 'utf8')

    const results = await server.searchWorkspaceFiles({
      threadId: thread.id,
      query: 'docs/ACP'
    })

    assert.deepEqual(results, [{ path: 'docs/ACP_CAPABILITY_GAP.md', includeIgnored: true }])
  })
})

test('YachiyoServer does not surface exact ignored path matches for bare @file validation', async () => {
  await withServer(async ({ server, workspacePathForThread }) => {
    const thread = await server.createThread()
    const workspacePath = workspacePathForThread(thread.id)

    await mkdir(workspacePath, { recursive: true })
    await writeFile(join(workspacePath, '.gitignore'), 'secret.txt\n', 'utf8')
    await writeFile(join(workspacePath, 'secret.txt'), 'top secret\n', 'utf8')

    const results = await server.searchWorkspaceFiles({
      threadId: thread.id,
      query: 'secret.txt'
    })

    assert.deepEqual(results, [])
  })
})
