import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { encryptProviderBackup, decryptProviderBackup } from '../../../settings/providerBackup.ts'
import {
  createResponsesWebSocketSupportStore,
  responsesEndpointKey
} from '../../../runtime/providers/responsesWebSocketSupport.ts'
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

test('stale settings drafts cannot erase or resurrect learned WebSocket fallback; only Retry clears it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-config-ws-'))
  const path = join(root, 'config.toml')
  const settingsStore = createSettingsStore(path)
  const domain = new YachiyoServerConfigDomain({ settingsStore, emit: () => {} })
  const support = createResponsesWebSocketSupportStore({
    read: () => domain.getConfig(),
    write: (settings) => domain.saveConfig(settings, false)
  })
  try {
    const initial = domain.saveConfig({
      providers: [
        {
          id: 'provider',
          name: 'Provider',
          type: 'openai-responses',
          apiKey: '',
          baseUrl: 'https://example.test/v1',
          modelList: { enabled: ['model'], disabled: [] }
        }
      ]
    })
    const endpoint = responsesEndpointKey('https://example.test/v1/responses')
    support.markUnsupported('provider', endpoint)
    initial.providers[0]!.name = 'Unrelated edit'
    const learned = domain.saveConfig(initial)
    assert.equal(learned.providers[0]?.responsesWebSocketUnsupportedEndpoint, endpoint)

    const retry = structuredClone(learned)
    retry.providers[0]!.responsesWebSocketUnsupportedEndpoint = ''
    const reset = domain.saveConfig(retry)
    assert.equal(reset.providers[0]?.responsesWebSocketUnsupportedEndpoint, undefined)
    assert.equal(support.isUnsupported('provider', endpoint), false)
    assert.ok(!(await readFile(path, 'utf8')).includes('responsesWebSocketUnsupportedEndpoint'))
    const backup = await encryptProviderBackup(reset.providers, 'fixture password')
    const restored = await decryptProviderBackup(backup, 'fixture password')
    assert.equal(restored[0]?.responsesWebSocketUnsupportedEndpoint, undefined)
    // A different window still holding the old nonempty digest cannot resurrect it.
    assert.equal(
      domain.saveConfig(learned).providers[0]?.responsesWebSocketUnsupportedEndpoint,
      undefined
    )

    support.markUnsupported('provider', endpoint)
    const editedEndpoint = domain.getConfig()
    editedEndpoint.providers[0]!.baseUrl = 'https://changed.test/v1'
    const changed = domain.saveConfig(editedEndpoint)
    assert.equal(changed.providers[0]?.responsesWebSocketUnsupportedEndpoint, undefined)
    const nextEndpoint = responsesEndpointKey('https://changed.test/v1/responses')
    assert.equal(support.isUnsupported('provider', nextEndpoint), false)
    support.markUnsupported('provider', nextEndpoint)
    changed.providers[0]!.responsesWebSocket = false
    const disabled = domain.saveConfig(changed)
    assert.equal(disabled.providers[0]?.responsesWebSocket, false)
    assert.equal(disabled.providers[0]?.responsesWebSocketUnsupportedEndpoint, nextEndpoint)
    disabled.providers[0]!.type = 'openai'
    assert.equal(
      domain.saveConfig(disabled).providers[0]?.responsesWebSocketUnsupportedEndpoint,
      undefined
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
