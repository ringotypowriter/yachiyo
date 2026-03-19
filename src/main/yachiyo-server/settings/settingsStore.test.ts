import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { DEFAULT_ENABLED_TOOL_NAMES } from '../../../shared/yachiyo/protocol.ts'
import {
  DEFAULT_SETTINGS_CONFIG,
  createSettingsStore,
  normalizeSettingsConfig,
  toProviderSettings
} from './settingsStore.ts'

test('settings store persists multi-provider config as TOML', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-settings-store-'))
  const settingsPath = join(root, 'config.toml')
  const store = createSettingsStore(settingsPath)

  try {
    const config: Parameters<typeof store.write>[0] = {
      enabledTools: ['read', 'bash'],
      chat: {
        activeRunEnterBehavior: 'enter-queues-follow-up'
      },
      providers: [
        {
          name: 'work',
          type: 'openai' as const,
          apiKey: 'sk-work',
          baseUrl: 'https://openrouter.example/v1',
          modelList: {
            enabled: ['gpt-5', 'gpt-4.1'],
            disabled: ['o3-mini']
          }
        },
        {
          name: 'backup',
          type: 'anthropic' as const,
          apiKey: 'sk-ant',
          baseUrl: '',
          modelList: {
            enabled: ['claude-opus-4-6'],
            disabled: []
          }
        }
      ]
    }

    store.write(config)

    assert.deepEqual(store.read(), config)

    const toml = await readFile(settingsPath, 'utf8')
    assert.match(toml, /enabledTools = \["read","bash"\]/)
    assert.match(toml, /activeRunEnterBehavior = "enter-queues-follow-up"/)
    assert.match(toml, /\[\[providers\]\]/)
    assert.match(toml, /\[providers\.modelList\]/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('settings store returns the default config when the file is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-settings-default-'))
  const settingsPath = join(root, 'config.toml')
  const store = createSettingsStore(settingsPath)

  try {
    assert.deepEqual(store.read(), DEFAULT_SETTINGS_CONFIG)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('toProviderSettings resolves the active provider snapshot', () => {
  const snapshot = toProviderSettings({
    enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
    chat: {
      activeRunEnterBehavior: 'enter-steers'
    },
    providers: [
      {
        name: 'work',
        type: 'openai',
        apiKey: 'sk-openai',
        baseUrl: 'https://api.openai.com/v1',
        modelList: {
          enabled: [],
          disabled: []
        }
      },
      {
        name: 'backup',
        type: 'anthropic',
        apiKey: 'sk-ant',
        baseUrl: '',
        modelList: {
          enabled: ['claude-opus-4-6'],
          disabled: ['claude-sonnet-4-5']
        }
      }
    ]
  })

  assert.equal(snapshot.providerName, 'backup')
  assert.equal(snapshot.provider, 'anthropic')
  assert.equal(snapshot.model, 'claude-opus-4-6')
  assert.equal(snapshot.apiKey, 'sk-ant')
})

test('normalizeSettingsConfig falls back to the default active-run input behavior', () => {
  assert.deepEqual(normalizeSettingsConfig({ providers: [] }).chat, {
    activeRunEnterBehavior: 'enter-steers'
  })

  assert.deepEqual(
    normalizeSettingsConfig({
      chat: {
        activeRunEnterBehavior: 'not-a-real-mode'
      },
      providers: []
    }).chat,
    {
      activeRunEnterBehavior: 'enter-steers'
    }
  )
})
