import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createInMemoryYachiyoStorage } from '../../../storage/memoryStorage.ts'
import { YachiyoServer } from '../YachiyoServer.ts'

test('connecting another client does not recover a running task as an interrupted task', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-client-reconnect-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(settingsPath, '[toolModel]\nmode = "disabled"\n')
  const storage = createInMemoryYachiyoStorage()
  const server = new YachiyoServer({
    storage,
    settingsPath,
    readSoulDocument: async () => null,
    readUserDocument: async () => null
  })
  t.after(async () => {
    await server.close()
    await rm(root, { recursive: true, force: true })
  })
  await server.bootstrap()
  const createdAt = new Date().toISOString()
  const thread = { id: 'live-thread', title: 'Live task', updatedAt: createdAt }
  storage.createThread({ thread, createdAt, messages: [] })
  storage.startRun({
    runId: 'live-run',
    thread,
    updatedThread: thread,
    requestMessageId: 'request',
    createdAt
  })
  storage.createToolCall({
    id: 'live-tool',
    runId: 'live-run',
    threadId: thread.id,
    requestMessageId: 'request',
    toolName: 'bash',
    status: 'running',
    inputSummary: 'working',
    startedAt: createdAt
  })
  const [first, second] = await Promise.all([server.bootstrap(), server.bootstrap()])
  assert.equal(first.latestRunsByThread[thread.id]?.status, 'running')
  assert.equal(second.latestRunsByThread[thread.id]?.status, 'running')
  assert.equal(
    storage.listThreadToolCalls(thread.id).find((tool) => tool.id === 'live-tool')?.status,
    'running'
  )
})
