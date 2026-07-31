import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createProviderCredentialVault } from '../../../settings/providerCredentialVault.ts'
import { createSettingsStore, DEFAULT_SETTINGS_CONFIG } from '../../../settings/settingsStore.ts'
import type { SettingsConfig } from '@yachiyo/shared/protocol'
import { resolveRunModeEnabledToolsForInput, YachiyoServerConfigDomain } from './configDomain.ts'

test('resolveRunModeEnabledToolsForInput preserves internal tool presets', () => {
  assert.deepEqual(
    resolveRunModeEnabledToolsForInput({ toolPreset: ['querySource', 'reviewThings'] }),
    ['querySource', 'reviewThings']
  )
})

test('saveToolPreferences ignores deprecated global tool preferences', () => {
  let config: SettingsConfig = {
    ...DEFAULT_SETTINGS_CONFIG,
    providers: []
  }
  const domain = new YachiyoServerConfigDomain({
    settingsStore: {
      read: () => config,
      write: (nextConfig) => {
        config = nextConfig
        return true
      }
    },
    emit: () => {}
  })

  const nextConfig = domain.saveToolPreferences({ enabledTools: ['read', 'edit'], runMode: 'chat' })

  assert.deepEqual(nextConfig, config)
  assert.equal(nextConfig.enabledTools, undefined)
  assert.equal(nextConfig.runMode, undefined)
})

test('applySyncedConfig preserves this device provider credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-config-domain-sync-'))
  const settingsStore = createSettingsStore(join(root, 'config.toml'), {
    providerCredentialVault: createProviderCredentialVault({
      vaultPath: join(root, 'provider-credentials.enc'),
      encryptionKey: Buffer.alloc(32, 0x45)
    })
  })
  const domain = new YachiyoServerConfigDomain({ settingsStore, emit: () => {} })

  try {
    domain.saveConfig({
      providers: [
        {
          id: 'provider-device',
          name: 'provider-device',
          type: 'anthropic',
          apiKey: 'sk-device-local',
          baseUrl: '',
          modelList: { enabled: ['claude-sonnet-4-5'], disabled: [] }
        }
      ]
    })

    const synced = domain.applySyncedConfig({
      providers: [
        {
          id: 'provider-device',
          name: 'provider-device',
          type: 'anthropic',
          apiKey: 'sk-from-legacy-sync-history',
          baseUrl: '',
          modelList: { enabled: ['claude-opus-4-6'], disabled: [] }
        }
      ]
    })

    assert.equal(synced.providers[0]?.apiKey, 'sk-device-local')
    assert.deepEqual(synced.providers[0]?.modelList.enabled, ['claude-opus-4-6'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
