import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  decryptProviderBackup,
  encryptProviderBackup
} from '@yachiyo/runtime/settings/providerBackup'
import type { ProviderConfig, SettingsConfig } from '@yachiyo/shared/protocol'

import type { CliConfigService } from './core/types.ts'
import { runYachiyoCli } from './yachiyoCli.ts'

const provider: ProviderConfig = {
  id: 'provider-work',
  name: 'work',
  type: 'anthropic',
  apiKey: 'sk-private',
  baseUrl: 'https://api.anthropic.com',
  modelList: { enabled: ['claude-sonnet-4-6'], disabled: [] }
}

function createConfigService(initialProviders: ProviderConfig[]): {
  readConfig: () => SettingsConfig
  readSaveCount: () => number
  service: CliConfigService
} {
  let config: SettingsConfig = { providers: structuredClone(initialProviders) }
  let saveCount = 0

  return {
    readConfig: () => structuredClone(config),
    readSaveCount: () => saveCount,
    service: {
      getConfig: () => structuredClone(config),
      saveConfig: (input) => {
        saveCount += 1
        config = structuredClone(input)
        return structuredClone(config)
      },
      upsertProvider: () => {
        throw new Error('Not implemented in this test')
      },
      setDefaultProvider: () => {
        throw new Error('Not implemented in this test')
      },
      fetchProviderModels: async () => []
    }
  }
}

test('provider export writes a password-encrypted backup file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-provider-backup-'))
  const backupPath = join(root, 'providers.yachiyo-provider-backup')
  let stdout = ''
  const config = createConfigService([provider])

  try {
    await runYachiyoCli(['provider', 'export', backupPath, '--password-stdin'], {
      createConfigService: () => config.service,
      readStdin: async () => 'correct horse battery staple\n',
      stdout: {
        write(chunk) {
          stdout += String(chunk)
          return true
        }
      }
    })

    assert.deepEqual(JSON.parse(stdout), {
      exported: 1,
      path: backupPath
    })
    assert.deepEqual(
      await decryptProviderBackup(
        await readFile(backupPath, 'utf8'),
        'correct horse battery staple'
      ),
      [provider]
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider import merges the encrypted backup into the current config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-provider-backup-'))
  const backupPath = join(root, 'providers.yachiyo-provider-backup')
  const localProvider = { ...provider, id: 'local-work-id', apiKey: 'old-key' }
  const localOnly: ProviderConfig = {
    id: 'local-only-id',
    name: 'local-only',
    type: 'openai',
    apiKey: 'local-key',
    baseUrl: '',
    modelList: { enabled: ['gpt-local'], disabled: [] }
  }
  const importedProvider = { ...provider, id: 'backup-work-id', apiKey: 'new-key' }
  const importedOnly: ProviderConfig = {
    id: 'backup-only-id',
    name: 'backup-only',
    type: 'gemini',
    apiKey: 'backup-key',
    baseUrl: '',
    modelList: { enabled: ['gemini-new'], disabled: [] }
  }
  const config = createConfigService([localProvider, localOnly])
  let stdout = ''

  try {
    await writeFile(
      backupPath,
      await encryptProviderBackup([importedProvider, importedOnly], 'correct horse battery staple')
    )
    await runYachiyoCli(['provider', 'import', backupPath, '--password-stdin'], {
      createConfigService: () => config.service,
      readStdin: async () => 'correct horse battery staple\n',
      stdout: {
        write(chunk) {
          stdout += String(chunk)
          return true
        }
      }
    })

    assert.deepEqual(JSON.parse(stdout), {
      imported: 2,
      total: 3,
      path: backupPath
    })
    assert.deepEqual(config.readConfig().providers, [
      { ...importedProvider, id: 'local-work-id' },
      localOnly,
      importedOnly
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('provider import leaves the config untouched when the password is wrong', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-provider-backup-'))
  const backupPath = join(root, 'providers.yachiyo-provider-backup')
  const config = createConfigService([provider])

  try {
    await writeFile(
      backupPath,
      await encryptProviderBackup([provider], 'correct horse battery staple')
    )

    await assert.rejects(
      () =>
        runYachiyoCli(['provider', 'import', backupPath, '--password-stdin'], {
          createConfigService: () => config.service,
          readStdin: async () => 'wrong password\n',
          stdout: { write: () => true }
        }),
      /password is incorrect/i
    )
    assert.equal(config.readSaveCount(), 0)
    assert.deepEqual(config.readConfig().providers, [provider])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
