import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { SyncStatus, YachiyoServerEvent } from '@yachiyo/shared/protocol'
import { createProviderCredentialVault } from '../../../settings/providerCredentialVault.ts'
import { stripProviderCredentials } from '../../../settings/providerCredentialConfig.ts'
import { createInMemoryYachiyoStorage } from '../../../storage/memoryStorage.ts'
import { YachiyoServer } from '../YachiyoServer.ts'

test('sync imports credentials into a running server and refreshes its settings event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yachiyo-server-credential-sync-'))
  const syncDir = join(root, 'sync')
  mkdirSync(syncDir)
  writeFileSync(join(syncDir, 'universe.json'), JSON.stringify({ universeId: 'fixture-universe' }))
  const servers: YachiyoServer[] = []
  const events: YachiyoServerEvent[] = []
  const originalCwd = process.cwd()
  try {
    // Run the real host export/import orchestration without loading native SQLite.
    // Node executes these command fixtures on every supported desktop platform.
    const syncCommand = `
const value = (flag) => process.argv[process.argv.indexOf(flag) + 1]
const fs = require('node:fs')
const path = require('node:path')
const incoming = path.join(value('--home'), 'import-config.toml')
if (path.basename(process.argv[1]) === 'import' && fs.existsSync(incoming)) {
  fs.copyFileSync(incoming, path.join(value('--home'), 'config.toml'))
  fs.unlinkSync(incoming)
}
process.stdout.write(JSON.stringify({
  state: 'ready',
  sync_dir: value('--sync-dir'),
  device_id: require('node:path').basename(value('--home')),
  device_count: 2,
  pending_conflict_count: 0
}))
`
    writeFileSync(join(root, 'export'), syncCommand)
    writeFileSync(join(root, 'import'), syncCommand)
    for (const [index, id] of ['device-a', 'device-b'].entries()) {
      const home = join(root, id)
      const deviceDir = join(syncDir, 'devices', id)
      mkdirSync(deviceDir, { recursive: true })
      writeFileSync(join(deviceDir, 'manifest.json'), JSON.stringify({ deviceId: id }))
      servers.push(
        new YachiyoServer({
          storage: createInMemoryYachiyoStorage(),
          settingsPath: join(home, 'config.toml'),
          providerCredentialVault: createProviderCredentialVault({
            vaultPath: join(home, 'provider-credentials.enc'),
            encryptionKey: Buffer.alloc(32, index + 1)
          }),
          seedPresetProviders: false,
          readSoulDocument: async () => null,
          readUserDocument: async () => null
        })
      )
    }
    const [a, b] = servers
    await b.saveConfig({
      providers: [
        {
          id: 'provider',
          name: 'Provider',
          type: 'openai',
          apiKey: 'fixture-server-synced-key',
          baseUrl: 'https://example.test/v1',
          modelList: { enabled: ['model'], disabled: [] }
        }
      ]
    })
    await a.saveConfig(stripProviderCredentials(await b.getConfig()))
    a.subscribe((event) => events.push(event))
    process.chdir(root)
    const cycle = (server: YachiyoServer, deviceId: string): Promise<SyncStatus> => {
      return (
        server as unknown as {
          exportThenImport(
            binary: string,
            home: string,
            syncDir: string,
            recommended: string
          ): Promise<SyncStatus>
        }
      ).exportThenImport(process.execPath, join(root, deviceId), syncDir, syncDir)
    }
    await cycle(b, 'device-b')
    await cycle(a, 'device-a')
    await cycle(b, 'device-b')
    await cycle(a, 'device-a')
    assert.equal((await a.getSettings()).apiKey, 'fixture-server-synced-key')
    const updated = events.find((event) => event.type === 'settings.updated')
    assert.equal(updated?.settings.apiKey, 'fixture-server-synced-key')
    const eventCount = events.length
    await cycle(a, 'device-a')
    assert.equal(
      events.length,
      eventCount,
      'an unchanged sync must not trigger another settings save'
    )

    const changed = await b.getConfig()
    changed.providers[0].modelList.enabled = ['updated-model']
    await b.saveConfig(changed)
    writeFileSync(
      join(root, 'device-a/import-config.toml'),
      readFileSync(join(root, 'device-b/config.toml'))
    )
    await cycle(a, 'device-a')
    const settingsEvents = events.filter((event) => event.type === 'settings.updated')
    assert.equal(settingsEvents.at(-1)?.settings.model, 'updated-model')
    assert.equal(settingsEvents.at(-1)?.settings.apiKey, 'fixture-server-synced-key')
    assert.equal(events.length, eventCount + 1)
  } finally {
    process.chdir(originalCwd)
    for (const server of servers) await server.close()
    rmSync(root, { recursive: true, force: true })
  }
})
