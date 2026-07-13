import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderConfig, SettingsConfig } from '@yachiyo/shared/protocol'
import {
  applyOnboardingSelection,
  listOnboardingPresets,
  shouldShowOnboarding
} from './onboardingSetup.ts'

function makeConfig(providers: ProviderConfig[]): SettingsConfig {
  return { providers } as SettingsConfig
}

function makePresetProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-anthropic',
    presetKey: 'anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    apiKey: '',
    baseUrl: 'https://api.anthropic.com/v1',
    modelList: { enabled: [], disabled: [] },
    ...overrides
  }
}

test('listOnboardingPresets excludes providers that need more than an API key', () => {
  const presets = listOnboardingPresets()
  assert.ok(presets.length > 0)
  assert.ok(presets.some((p) => p.key === 'anthropic'))
  assert.ok(!presets.some((p) => p.type === 'vertex'))
  assert.ok(!presets.some((p) => p.type === 'openai-codex'))
  // Ollama is keyless; the onboarding key step cannot complete it.
  assert.ok(!presets.some((p) => p.key === 'ollama'))
})

test('shouldShowOnboarding only fires for a loaded config without usable providers', () => {
  assert.equal(shouldShowOnboarding({ config: null, dismissed: false }), false)
  assert.equal(
    shouldShowOnboarding({ config: makeConfig([makePresetProvider()]), dismissed: false }),
    true
  )
  assert.equal(
    shouldShowOnboarding({ config: makeConfig([makePresetProvider()]), dismissed: true }),
    false
  )
  const usable = makePresetProvider({ modelList: { enabled: ['claude-sonnet-5'], disabled: [] } })
  assert.equal(shouldShowOnboarding({ config: makeConfig([usable]), dismissed: false }), false)
})

test('applyOnboardingSelection updates the existing preset provider in place', () => {
  const config = makeConfig([
    makePresetProvider({ modelList: { enabled: [], disabled: ['claude-sonnet-5', 'other'] } })
  ])

  const next = applyOnboardingSelection(config, {
    presetKey: 'anthropic',
    apiKey: '  sk-test  ',
    model: 'claude-sonnet-5'
  })

  assert.equal(next.providers.length, 1)
  const provider = next.providers[0]
  assert.equal(provider.apiKey, 'sk-test')
  assert.deepEqual(provider.modelList.enabled, ['claude-sonnet-5'])
  assert.deepEqual(provider.modelList.disabled, ['other'])
  assert.deepEqual(next.defaultModel, { providerName: 'Anthropic', model: 'claude-sonnet-5' })
  // Input config stays untouched.
  assert.equal(config.providers[0].apiKey, '')
  assert.equal(config.defaultModel, undefined)
})

test('applyOnboardingSelection appends a provider when the preset is missing', () => {
  const next = applyOnboardingSelection(makeConfig([]), {
    presetKey: 'deepseek',
    apiKey: 'sk-ds',
    model: 'deepseek-chat'
  })

  assert.equal(next.providers.length, 1)
  const provider = next.providers[0]
  assert.equal(provider.presetKey, 'deepseek')
  assert.equal(provider.type, 'openai')
  assert.equal(provider.baseUrl, 'https://api.deepseek.com/v1')
  assert.deepEqual(provider.modelList.enabled, ['deepseek-chat'])
  assert.deepEqual(next.defaultModel, { providerName: 'DeepSeek', model: 'deepseek-chat' })
})
