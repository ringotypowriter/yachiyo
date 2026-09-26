import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { SyncConflictRecord } from '@yachiyo/shared/protocol'
import { createInMemoryYachiyoStorage } from '../../../storage/memoryStorage.ts'
import type { YachiyoStorage } from '../../../storage/storage.ts'
import { YachiyoServer } from '../YachiyoServer.ts'

const localToml = `[general]
chatFontSize = 18
chatPanelOpacity = 0.49
contextTimeZone = "Asia/Shanghai"
`

const remoteToml = (contextTimeZone: string): string => `[general]
chatFontSize = 16
chatPanelOpacity = 0.36
contextTimeZone = "${contextTimeZone}"
`

function conflict(id: string, remoteHash: string, text: string): SyncConflictRecord {
  return {
    id,
    opId: `op-${id}`,
    deviceId: 'remote-device',
    entityType: 'settings',
    entityId: 'config.toml',
    localHash: `local-${id}`,
    remoteHash,
    payloadJson: JSON.stringify({ text }),
    createdAt: '2026-09-02T00:00:00.000Z'
  }
}

test('settings conflicts ask only about fields not resolved in an earlier merge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-sync-resolution-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(settingsPath, localToml, 'utf8')

  const memoryStorage = createInMemoryYachiyoStorage()
  let activeConflicts = [
    conflict('first', 'remote-first', remoteToml('Asia/Shanghai')),
    conflict('duplicate', 'remote-duplicate', remoteToml('Asia/Shanghai'))
  ]
  const storage: YachiyoStorage = {
    ...memoryStorage,
    listSyncConflicts: () => activeConflicts,
    countPendingSyncConflicts: () => activeConflicts.length,
    resolveSyncConflict: (input) => {
      const resolved = activeConflicts.find((item) => item.id === input.conflictId)
      activeConflicts = activeConflicts.filter((item) => item.id !== input.conflictId)
      return resolved
    },
    deleteSyncConflict: (conflictId) => {
      activeConflicts = activeConflicts.filter((item) => item.id !== conflictId)
    }
  }
  const server = new YachiyoServer({
    storage,
    settingsPath,
    seedPresetProviders: false,
    readSoulDocument: async () => null,
    readUserDocument: async () => null
  })

  try {
    const first = await server.listSyncConflicts()
    assert.deepEqual(
      first.conflicts[0]?.settingsFields?.map((field) => field.path),
      ['general.chatFontSize', 'general.chatPanelOpacity']
    )

    const afterResolve = await server.resolveSyncConflict({
      conflictId: 'first',
      resolution: 'merge'
    })
    assert.deepEqual(afterResolve.conflicts, [])

    activeConflicts = [conflict('second', 'remote-second', remoteToml('UTC'))]
    const second = await server.listSyncConflicts()
    assert.deepEqual(
      second.conflicts[0]?.settingsFields?.map((field) => field.path),
      ['general.contextTimeZone']
    )
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
})

async function withSnapshotConflict(
  id: string,
  localText: string,
  remoteText: string,
  baseText: string,
  check: (
    server: YachiyoServer,
    settingsPath: string,
    pending: () => SyncConflictRecord[]
  ) => Promise<void>,
  storageOverrides: Partial<YachiyoStorage> = {}
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-sync-fields-'))
  const settingsPath = join(root, 'config.toml')
  await writeFile(settingsPath, localText)
  const incoming = conflict(id, `remote-${id}`, remoteText)
  incoming.payloadJson = JSON.stringify({
    text: remoteText,
    baseText,
    baseHash: `sha256:${createHash('sha256').update(baseText).digest('hex')}`,
    originSeq: 2,
    causalClock: {}
  })
  let active = [incoming]
  const server = new YachiyoServer({
    storage: {
      ...createInMemoryYachiyoStorage(),
      ...storageOverrides,
      listSyncConflicts: () => active,
      resolveSyncConflict: ({ conflictId }) => {
        const resolved = active.find((item) => item.id === conflictId)
        active = active.filter((item) => item.id !== conflictId)
        return resolved
      },
      deleteSyncConflict: (conflictId) => {
        active = active.filter((item) => item.id !== conflictId)
      }
    },
    settingsPath,
    seedPresetProviders: false,
    readSoulDocument: async () => null,
    readUserDocument: async () => null
  })
  try {
    ;(server as unknown as { reconcileSyncConflicts(): void }).reconcileSyncConflicts()
    await check(server, settingsPath, () => active)
  } finally {
    await server.close()
    await rm(root, { recursive: true, force: true })
  }
}

test('settings changes on different fields merge without asking the user', async () => {
  await withSnapshotConflict(
    'disjoint',
    '[general]\nchatFontSize = 18\nchatPanelOpacity = 0.5\n',
    '[general]\nchatFontSize = 16\nchatPanelOpacity = 0.36\n',
    '[general]\nchatFontSize = 16\nchatPanelOpacity = 0.5\n',
    async (_server, settingsPath, pending) => {
      assert.deepEqual(pending(), [])
      const text = await readFile(settingsPath, 'utf8')
      assert.match(text, /chatFontSize = 18/)
      assert.match(text, /chatPanelOpacity = 0\.36/)
    }
  )
})

test('settings changes on the same field still require a choice', async () => {
  await withSnapshotConflict(
    'overlap',
    '[general]\nchatFontSize = 18\n',
    '[general]\nchatFontSize = 20\n',
    '[general]\nchatFontSize = 16\n',
    async (_server, settingsPath, pending) => {
      assert.equal(pending().length, 1)
      assert.match(await readFile(settingsPath, 'utf8'), /chatFontSize = 18/)
    }
  )
})

test('an overlapping settings edit asks only about that field and preserves other local edits', async () => {
  await withSnapshotConflict(
    'partial',
    '[general]\nchatFontSize = 18\nchatPanelOpacity = 0.5\ncontextTimeZone = "Asia/Shanghai"\n',
    '[general]\nchatFontSize = 20\nchatPanelOpacity = 0.36\ncontextTimeZone = "UTC"\n',
    '[general]\nchatFontSize = 16\nchatPanelOpacity = 0.5\ncontextTimeZone = "UTC"\n',
    async (server, settingsPath) => {
      assert.deepEqual(
        (await server.listSyncConflicts()).conflicts[0]?.settingsFields?.map((field) => field.path),
        ['general.chatFontSize']
      )
      const before = await readFile(settingsPath, 'utf8')
      assert.match(before, /chatPanelOpacity = 0\.5/)
      assert.match(before, /contextTimeZone = "Asia\/Shanghai"/)
      await server.resolveSyncConflict({ conflictId: 'partial', resolution: 'use_remote' })
      const after = await readFile(settingsPath, 'utf8')
      assert.match(after, /chatFontSize = 20/)
      assert.match(after, /chatPanelOpacity = 0\.36/)
      assert.match(after, /contextTimeZone = "Asia\/Shanghai"/)
    }
  )
})

test('an already superseded settings conflict does not restore an older value', async () => {
  const local = '[general]\nchatFontSize = 16\nchatPanelOpacity = 0.36\n'
  await withSnapshotConflict(
    'stale',
    local,
    '[general]\nchatFontSize = 18\nchatPanelOpacity = 0.5\n',
    '[general]\nchatFontSize = 16\nchatPanelOpacity = 0.5\n',
    async (_server, settingsPath, pending) => {
      assert.deepEqual(pending(), [])
      assert.equal(await readFile(settingsPath, 'utf8'), local)
    },
    {
      isSyncSettingsSnapshotSuperseded: (deviceId, seq) => deviceId === 'remote-device' && seq <= 2
    }
  )
})

test('keeping a locally edited field still accepts the remote snapshot ancestry', async () => {
  let acceptedSeq: number | undefined
  await withSnapshotConflict(
    'keep-local',
    '[general]\nchatFontSize = 18\nchatPanelOpacity = 0.5\n',
    '[general]\nchatFontSize = 20\nchatPanelOpacity = 0.36\n',
    '[general]\nchatFontSize = 16\nchatPanelOpacity = 0.5\n',
    async (server, settingsPath) => {
      await server.resolveSyncConflict({ conflictId: 'keep-local', resolution: 'keep_local' })
      const text = await readFile(settingsPath, 'utf8')
      assert.match(text, /chatFontSize = 18/)
      assert.match(text, /chatPanelOpacity = 0\.36/)
      assert.equal(acceptedSeq, 2)
    },
    { rememberSyncSettingsBaseHash: (_hash, snapshot) => (acceptedSeq = snapshot?.seq) }
  )
})
