import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { YachiyoServer } from './YachiyoServer.ts'
import { createInMemoryYachiyoStorage } from './memoryStorage.ts'
import type { ModelStreamRequest } from './types.ts'

async function withServer(
  fn: (input: {
    server: YachiyoServer
    completeRun: (runId: string) => Promise<void>
    waitForEvent: (type: string) => Promise<unknown>
  }) => Promise<void>,
  options: {
    now?: () => Date
  } = {}
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-server-test-'))
  const settingsPath = join(root, 'config.toml')
  const storage = createInMemoryYachiyoStorage()

  const waiters = new Map<string, Array<(value: unknown) => void>>()
  const seenEvents = new Map<string, unknown[]>()
  const settle = (type: string, value: unknown): void => {
    const seen = seenEvents.get(type) ?? []
    seen.push(value)
    seenEvents.set(type, seen)

    const queue = waiters.get(type)
    if (!queue || queue.length === 0) return
    const next = queue.shift()
    next?.(value)
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
    createModelRuntime: () => ({
      async *streamReply(request: ModelStreamRequest) {
        if (request.messages.at(-1)?.content.includes('cancel me')) {
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
    })
  })

  const unsubscribe = server.subscribe((event) => {
    settle(event.type, event)
  })

  try {
    await fn({
      server,
      completeRun: (runId) =>
        Promise.race([
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

            const completedQueue = waiters.get('run.completed') ?? []
            completedQueue.push((event) => {
              const payload = event as { runId: string }
              if (payload.runId === runId) resolve()
            })
            waiters.set('run.completed', completedQueue)

            const failedQueue = waiters.get('run.failed') ?? []
            failedQueue.push((event) => {
              const payload = event as { runId: string; error: string }
              if (payload.runId === runId) reject(new Error(payload.error))
            })
            waiters.set('run.failed', failedQueue)
          }),
          new Promise<void>((resolve) => {
            const cancelled = takeSeenEvent<{ runId: string }>(
              'run.cancelled',
              (event) => event.runId === runId
            )
            if (cancelled) {
              resolve()
              return
            }

            const cancelledQueue = waiters.get('run.cancelled') ?? []
            cancelledQueue.push((event) => {
              const payload = event as { runId: string }
              if (payload.runId === runId) resolve()
            })
            waiters.set('run.cancelled', cancelledQueue)
          })
        ]),
      waitForEvent: (type) =>
        new Promise((resolve) => {
          const seen = seenEvents.get(type)
          if (seen && seen.length > 0) {
            resolve(seen.shift())
            return
          }

          const queue = waiters.get(type) ?? []
          queue.push(resolve)
          waiters.set(type, queue)
        })
    })
  } finally {
    unsubscribe()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}

test('YachiyoServer streams a reply and persists the completed thread state', async () => {
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
    const accepted = await server.sendChat({
      threadId: thread.id,
      content: 'Plan the MVP'
    })

    await completeRun(accepted.runId)

    const bootstrap = await server.bootstrap()
    const messages = bootstrap.messagesByThread[thread.id] ?? []

    assert.equal(messages.length, 2)
    assert.equal(messages[0]?.role, 'user')
    assert.equal(messages[0]?.content, 'Plan the MVP')
    assert.equal(messages[1]?.role, 'assistant')
    assert.equal(messages[1]?.content, 'Hello world')
    assert.equal(messages[1]?.modelId, 'gpt-5')
    assert.equal(messages[1]?.providerName, 'work')
    assert.equal(bootstrap.threads[0]?.title, 'Plan the MVP')
    assert.equal(bootstrap.threads[0]?.preview, 'Hello world')
  })
})

test('YachiyoServer cancels an active run without persisting partial assistant output', async () => {
  await withServer(async ({ server, completeRun, waitForEvent }) => {
    await server.upsertProvider({
      name: 'backup',
      type: 'anthropic',
      apiKey: 'sk-ant-test',
      baseUrl: '',
      modelList: {
        enabled: ['claude-opus-4-6'],
        disabled: []
      }
    })

    const thread = await server.createThread()
    const accepted = await server.sendChat({
      threadId: thread.id,
      content: 'Please cancel me halfway. cancel me'
    })

    await waitForEvent('message.delta')
    await server.cancelRun({ runId: accepted.runId })
    await completeRun(accepted.runId)

    const bootstrap = await server.bootstrap()
    const messages = bootstrap.messagesByThread[thread.id] ?? []

    assert.equal(messages.length, 1)
    assert.equal(messages[0]?.role, 'user')
    assert.equal(messages[0]?.content, 'Please cancel me halfway. cancel me')
  })
})

test('YachiyoServer renames and archives threads', async () => {
  await withServer(async ({ server }) => {
    const first = await server.createThread()
    const second = await server.createThread()

    const renamed = await server.renameThread({
      threadId: first.id,
      title: 'Pinned plan'
    })

    assert.equal(renamed.title, 'Pinned plan')

    await server.archiveThread({ threadId: second.id })

    const bootstrap = await server.bootstrap()

    assert.equal(bootstrap.threads.length, 1)
    assert.equal(bootstrap.threads[0]?.id, first.id)
    assert.equal(bootstrap.threads[0]?.title, 'Pinned plan')
  })
})

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
      assistantMessageId: firstAssistant!.id
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

    const branched = await server.createBranch({
      threadId: thread.id,
      messageId: retriedAssistant!.id
    })

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

test('YachiyoServer can switch the active thread branch between sibling replies', async () => {
  let tick = 0
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

    const secondRun = await server.sendChat({
      threadId: thread.id,
      content: 'Second question'
    })
    await completeRun(secondRun.runId)

    bootstrap = await server.bootstrap()
    const [, , secondUser, secondAssistant] = bootstrap.messagesByThread[thread.id] ?? []

    const retryRun = await server.retryMessage({
      threadId: thread.id,
      assistantMessageId: firstAssistant!.id
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
      (message) => message.parentMessageId === retryFollowUpUser?.id && message.role === 'assistant'
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
  }, {
    now: () => new Date(Date.UTC(2026, 2, 15, 0, 0, tick++))
  })
})

test('YachiyoServer deletes a user request anchor together with every attached response branch', async () => {
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
    const accepted = await server.sendChat({
      threadId: thread.id,
      content: 'First question'
    })
    await completeRun(accepted.runId)

    let bootstrap = await server.bootstrap()
    const [userMessage, assistantMessage] = bootstrap.messagesByThread[thread.id] ?? []

    const retryRun = await server.retryMessage({
      threadId: thread.id,
      assistantMessageId: assistantMessage!.id
    })
    await completeRun(retryRun.runId)

    bootstrap = await server.bootstrap()
    assert.equal((bootstrap.messagesByThread[thread.id] ?? []).length, 3)

    const nextDelete = await server.deleteMessageFromHere({
      threadId: thread.id,
      messageId: userMessage!.id
    })

    assert.deepEqual(nextDelete.messages, [])
    assert.equal(nextDelete.thread.headMessageId, undefined)
  })
})

test('YachiyoServer manages provider config and active model state', async () => {
  await withServer(async ({ server, waitForEvent }) => {
    await server.upsertProvider({
      name: 'work',
      type: 'openai',
      apiKey: 'sk-openai',
      baseUrl: 'https://api.openai.com/v1',
      modelList: {
        enabled: ['gpt-5', 'gpt-4.1'],
        disabled: ['o3-mini']
      }
    })

    const updatedEvent = waitForEvent('settings.updated')

    const event = (await updatedEvent) as {
      settings: { providerName: string; provider: string; model: string }
      config: {
        providers: Array<{ name: string; modelList: { enabled: string[]; disabled: string[] } }>
      }
    }

    assert.equal(event.settings.providerName, 'work')
    assert.equal(event.settings.provider, 'openai')
    assert.equal(event.settings.model, 'gpt-5')
    assert.equal(event.config.providers.length, 1)
    assert.deepEqual(event.config.providers[0]?.modelList.enabled, ['gpt-5', 'gpt-4.1'])

    await server.disableProviderModel({
      name: 'work',
      model: 'gpt-5'
    })

    const config = await server.getConfig()
    assert.deepEqual(config.providers[0]?.modelList.enabled, ['gpt-4.1'])
    assert.deepEqual(config.providers[0]?.modelList.disabled, ['gpt-5', 'o3-mini'])

    const snapshot = await server.getSettings()
    assert.equal(snapshot.providerName, 'work')
    assert.equal(snapshot.provider, 'openai')
    assert.equal(snapshot.model, 'gpt-4.1')
    assert.equal(snapshot.apiKey, 'sk-openai')
  })
})
