import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { YachiyoServer } from './YachiyoServer.ts'
import { createInMemoryYachiyoStorage } from '../storage/memoryStorage.ts'
import type { ModelStreamRequest } from '../runtime/types.ts'
import { RetryableRunError } from '../runtime/runtimeErrors.ts'

test('YachiyoServer cancels immediately while waiting to recover after partial output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-retry-cancel-test-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(settingsPath, '[toolModel]\nmode = "disabled"\n', 'utf8')

  const storage = createInMemoryYachiyoStorage()
  const modelRequests: ModelStreamRequest[] = []
  const eventTypes: string[] = []

  const server = new YachiyoServer({
    storage,
    settingsPath,
    readSoulDocument: async () => null,
    readUserDocument: async () => null,
    saveUserDocument: async () => null,
    ensureThreadWorkspace: async (threadId) => {
      const workspacePath = join(root, '.yachiyo', 'temp-workspace', threadId)
      await mkdir(workspacePath, { recursive: true })
      return workspacePath
    },
    createModelRuntime: () => ({
      async *streamReply(request: ModelStreamRequest): AsyncIterable<string> {
        modelRequests.push(request)
        yield 'Partial answer'
        const cause = Object.assign(new Error('net::ERR_CONNECTION_CLOSED'), { status: 0 })
        throw new RetryableRunError('net::ERR_CONNECTION_CLOSED', { cause })
      }
    })
  })

  const waitForEvent = (type: string, timeoutMs = 2_000): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`timed out waiting for ${type}`))
      }, timeoutMs)

      const unsubscribe = server.subscribe((event) => {
        eventTypes.push(event.type)
        if (event.type !== type) {
          return
        }

        clearTimeout(timer)
        unsubscribe()
        resolve()
      })
    })

  const unsubscribeEvents = server.subscribe((event) => {
    eventTypes.push(event.type)
  })

  try {
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
      content: 'Start recovering and let me stop it.'
    })

    await waitForEvent('run.retrying')

    const cancelStartedAt = Date.now()
    await server.cancelRun({ runId: accepted.runId })
    await waitForEvent('run.cancelled')
    const cancelElapsedMs = Date.now() - cancelStartedAt

    const bootstrap = await server.bootstrap()

    assert.equal(modelRequests.length, 1)
    assert.equal(bootstrap.latestRunsByThread[thread.id]?.status, 'cancelled')
    assert.ok(eventTypes.includes('run.retrying'))
    assert.ok(eventTypes.includes('run.cancelled'))
    assert.ok(
      cancelElapsedMs < 900,
      `cancel should interrupt recovery backoff promptly, got ${cancelElapsedMs}ms`
    )
  } finally {
    unsubscribeEvents()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('YachiyoServer cancels a stale persisted run even when no in-memory task exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-stale-cancel-test-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(settingsPath, '[toolModel]\nmode = "disabled"\n', 'utf8')

  const storage = createInMemoryYachiyoStorage()
  const eventTypes: string[] = []

  const server = new YachiyoServer({
    storage,
    settingsPath,
    readSoulDocument: async () => null,
    readUserDocument: async () => null,
    saveUserDocument: async () => null,
    ensureThreadWorkspace: async (threadId) => {
      const workspacePath = join(root, '.yachiyo', 'temp-workspace', threadId)
      await mkdir(workspacePath, { recursive: true })
      return workspacePath
    }
  })

  const unsubscribeEvents = server.subscribe((event) => {
    eventTypes.push(event.type)
  })

  try {
    const thread = await server.createThread()
    const runId = 'stale-run'

    storage.startRun({
      runId,
      thread,
      updatedThread: thread,
      createdAt: new Date().toISOString()
    })

    await server.cancelRun({ runId })

    const bootstrap = await server.bootstrap()

    assert.equal(bootstrap.latestRunsByThread[thread.id]?.status, 'cancelled')
    assert.ok(eventTypes.includes('run.cancelled'))
  } finally {
    unsubscribeEvents()
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
