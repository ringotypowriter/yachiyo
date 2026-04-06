import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { YachiyoServer } from './YachiyoServer.ts'
import { createInMemoryYachiyoStorage } from '../storage/memoryStorage.ts'
import type { ModelStreamRequest } from '../runtime/types.ts'

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
        const error = new Error('net::ERR_CONNECTION_CLOSED') as Error & { status?: number }
        error.status = 0
        throw error
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

test('YachiyoServer cancels a hung run after the inactivity timeout and does not resume it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-run-timeout-test-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(settingsPath, '[toolModel]\nmode = "disabled"\n', 'utf8')

  const storage = createInMemoryYachiyoStorage()
  const modelRequests: ModelStreamRequest[] = []

  const server = new YachiyoServer({
    storage,
    settingsPath,
    runInactivityTimeoutMs: 40,
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
        yield* []
        await new Promise<void>(() => {})
      }
    })
  })

  const waitForRunEvent = (
    type: 'run.cancelled' | 'run.completed' | 'run.failed',
    runId: string,
    timeoutMs = 2_000
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`timed out waiting for ${type} (${runId})`))
      }, timeoutMs)

      const unsubscribe = server.subscribe((event) => {
        if (event.type !== type || event.runId !== runId) {
          return
        }

        clearTimeout(timer)
        unsubscribe()
        resolve()
      })
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
    const firstAccepted = await server.sendChat({
      threadId: thread.id,
      content: 'This run will hang.'
    })

    await waitForRunEvent('run.cancelled', firstAccepted.runId)

    const cancelledBootstrap = await server.bootstrap()
    assert.equal(cancelledBootstrap.latestRunsByThread[thread.id]?.status, 'cancelled')
    assert.equal(storage.getRunRecoveryCheckpoint(firstAccepted.runId), undefined)

    const secondAccepted = await server.sendChat({
      threadId: thread.id,
      content: 'New request after timeout.'
    })

    assert.notEqual(secondAccepted.runId, firstAccepted.runId)
    await waitForRunEvent('run.cancelled', secondAccepted.runId)
    assert.equal(modelRequests.length, 2)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})
