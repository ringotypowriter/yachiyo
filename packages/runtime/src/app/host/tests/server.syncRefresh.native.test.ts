import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'
import { createSqliteYachiyoServer, type YachiyoServer } from '../YachiyoServer.ts'

async function createSyncServer(input: { home: string; syncDir: string }): Promise<YachiyoServer> {
  await mkdir(input.home, { recursive: true })
  const settingsPath = join(input.home, 'config.toml')
  await writeFile(
    settingsPath,
    `[sync]\nsyncDir = ${JSON.stringify(input.syncDir)}\n\n[toolModel]\nmode = "disabled"\n`,
    'utf8'
  )

  return createSqliteYachiyoServer({
    dbPath: join(input.home, 'yachiyo.sqlite'),
    settingsPath,
    createModelRuntime: () => ({
      async *streamReply() {
        yield 'unused'
      }
    }),
    readSoulDocument: async () => null,
    readUserDocument: async () => null,
    saveUserDocument: async () => null
  })
}

test('sync import notifies subscribers about a remote thread without restarting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-sync-refresh-'))
  const syncDir = join(root, 'sync')
  const serverA = await createSyncServer({ home: join(root, 'a'), syncDir })
  const serverB = await createSyncServer({ home: join(root, 'b'), syncDir })

  try {
    await serverA.initSync()
    await serverB.initSync()

    const remoteThread = await serverA.createThread({ title: 'Remote thread after startup' })
    const runCompleted = new Promise<void>((resolve) => {
      const unsubscribe = serverA.subscribe((event) => {
        if (event.type !== 'run.completed' || event.threadId !== remoteThread.id) return
        unsubscribe()
        resolve()
      })
    })
    await serverA.sendChat({ threadId: remoteThread.id, content: 'Persist this remote turn.' })
    await runCompleted
    await serverA.runSyncNow()

    const events: YachiyoServerEvent[] = []
    const unsubscribe = serverB.subscribe((event) => events.push(event))
    try {
      await serverB.runSyncNow()
    } finally {
      unsubscribe()
    }

    const bootstrap = await serverB.bootstrap()
    const importedThread = [...bootstrap.threads, ...bootstrap.archivedThreads].find(
      (thread) => thread.id === remoteThread.id
    )
    assert.equal(importedThread?.title, 'Remote thread after startup')
    const refresh = events.find(
      (event): event is Extract<YachiyoServerEvent, { type: 'thread.state.replaced' }> =>
        event.type === 'thread.state.replaced' && event.threadId === remoteThread.id
    )
    assert.ok(refresh, 'the renderer event stream must receive the newly imported remote thread')
    assert.equal(refresh.thread.title, 'Remote thread after startup')
    assert.ok(refresh.messages.some((message) => message.content === 'Persist this remote turn.'))

    const noOpEvents: YachiyoServerEvent[] = []
    const unsubscribeNoOp = serverB.subscribe((event) => noOpEvents.push(event))
    try {
      await serverB.runSyncNow()
    } finally {
      unsubscribeNoOp()
    }
    assert.deepEqual(noOpEvents, [], 'an import with no remote changes must not refresh the UI')

    await serverA.deleteThread({ threadId: remoteThread.id })
    await serverA.runSyncNow()
    const deleteEvents: YachiyoServerEvent[] = []
    const unsubscribeDelete = serverB.subscribe((event) => deleteEvents.push(event))
    try {
      await serverB.runSyncNow()
    } finally {
      unsubscribeDelete()
    }
    assert.ok(
      deleteEvents.some(
        (event) => event.type === 'thread.deleted' && event.threadId === remoteThread.id
      ),
      'the renderer event stream must remove a remotely deleted thread'
    )
    const afterDelete = await serverB.bootstrap()
    assert.ok(
      ![...afterDelete.threads, ...afterDelete.archivedThreads].some(
        (thread) => thread.id === remoteThread.id
      )
    )
  } finally {
    await serverA.close()
    await serverB.close()
    await rm(root, { recursive: true, force: true })
  }
})
