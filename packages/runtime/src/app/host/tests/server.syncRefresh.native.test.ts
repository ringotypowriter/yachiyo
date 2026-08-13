import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

async function sendAndWaitForCompletion(
  server: YachiyoServer,
  threadId: string,
  content: string
): Promise<void> {
  const runCompleted = new Promise<void>((resolve) => {
    const unsubscribe = server.subscribe((event) => {
      if (event.type !== 'run.completed' || event.threadId !== threadId) return
      unsubscribe()
      resolve()
    })
  })
  await server.sendChat({ threadId, content })
  await runCompleted
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
    await sendAndWaitForCompletion(serverA, remoteThread.id, 'Persist this remote turn.')
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

    await serverA.archiveThread({ threadId: remoteThread.id })
    await serverA.runSyncNow()
    await serverB.runSyncNow()

    await serverA.restoreThread({ threadId: remoteThread.id })
    await sendAndWaitForCompletion(
      serverA,
      remoteThread.id,
      'Refresh an already-open archived timeline.'
    )
    await serverA.archiveThread({ threadId: remoteThread.id })
    await serverA.runSyncNow()

    const archivedEvents: YachiyoServerEvent[] = []
    const unsubscribeArchived = serverB.subscribe((event) => archivedEvents.push(event))
    try {
      await serverB.runSyncNow()
    } finally {
      unsubscribeArchived()
    }
    const archivedRefresh = archivedEvents.find(
      (event): event is Extract<YachiyoServerEvent, { type: 'thread.archived' }> =>
        event.type === 'thread.archived' && event.threadId === remoteThread.id
    )
    assert.ok(archivedRefresh, 'the renderer event stream must keep the thread archived')
    assert.ok(
      archivedRefresh.messages?.some(
        (message) => message.content === 'Refresh an already-open archived timeline.'
      ),
      'an archived refresh must carry current child state to an already-open timeline'
    )

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

test('custom skills sync through the native core, disclose once, and resolve conflicts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-sync-skills-'))
  const syncDir = join(root, 'sync')
  const homeA = join(root, 'a')
  const homeB = join(root, 'b')
  const skillA = join(homeA, 'skills/custom/shared/SKILL.md')
  const skillB = join(homeB, 'skills/custom/shared/SKILL.md')
  await mkdir(join(homeA, 'skills/custom/shared'), { recursive: true })
  await writeFile(skillA, '# Shared\n\nInitial version.\n', 'utf8')
  const serverA = await createSyncServer({ home: homeA, syncDir })
  const serverB = await createSyncServer({ home: homeB, syncDir })

  try {
    const events: YachiyoServerEvent[] = []
    const unsubscribe = serverA.subscribe((event) => events.push(event))
    try {
      await serverA.initSync()
      await serverA.runSyncNow()
    } finally {
      unsubscribe()
    }
    assert.equal(
      events.filter((event) => event.type === 'sync.custom-skills-disclosure').length,
      1,
      'the full-tree disclosure must be visible once on the first successful skill export'
    )

    await serverB.initSync()
    assert.equal(await readFile(skillB, 'utf8'), '# Shared\n\nInitial version.\n')

    await writeFile(skillA, '# Shared\n\nVersion from A.\n', 'utf8')
    await writeFile(skillB, '# Shared\n\nVersion from B.\n', 'utf8')
    await serverA.runSyncNow()
    await serverB.runSyncNow()
    const conflicts = await serverB.listSyncConflicts()
    assert.equal(conflicts.conflicts.length, 1)
    assert.equal(conflicts.conflicts[0]?.entityType, 'skill')

    await serverB.resolveSyncConflict({
      conflictId: conflicts.conflicts[0]!.id,
      resolution: 'use_remote'
    })

    assert.equal(await readFile(skillB, 'utf8'), '# Shared\n\nVersion from A.\n')
    assert.deepEqual((await serverB.listSyncConflicts()).conflicts, [])
  } finally {
    await serverA.close()
    await serverB.close()
    await rm(root, { recursive: true, force: true })
  }
})
