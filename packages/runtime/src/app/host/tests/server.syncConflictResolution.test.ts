import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
