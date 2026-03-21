import assert from 'node:assert/strict'
import test from 'node:test'

import type { SettingsConfig } from '../../../../../shared/yachiyo/protocol.ts'
import { canOpenToolModelPicker, resolveModelSelectorState } from './modelSelectorState.ts'

const SETTINGS_FIXTURE: SettingsConfig = {
  providers: [
    {
      id: 'provider-1',
      name: 'OpenAI',
      type: 'openai',
      apiKey: '',
      baseUrl: '',
      modelList: {
        enabled: ['gpt-5', 'gpt-5-mini'],
        disabled: ['gpt-5.4']
      }
    }
  ]
}

test('keeps the tool-model picker reachable while a custom selection is stranded', () => {
  assert.equal(
    canOpenToolModelPicker({
      hasEnabledModels: false,
      toolModelMode: 'custom'
    }),
    true
  )

  assert.equal(
    canOpenToolModelPicker({
      hasEnabledModels: false,
      toolModelMode: 'disabled'
    }),
    false
  )
})

test('keeps the leading fallback option visible when search filters out every model', () => {
  assert.deepEqual(
    resolveModelSelectorState({
      config: SETTINGS_FIXTURE,
      hasLeadingOption: true,
      query: 'no-match'
    }),
    {
      providers: [],
      showEmptyState: true,
      showLeadingOption: true
    }
  )
})

test('filters selector results to enabled models only', () => {
  assert.deepEqual(
    resolveModelSelectorState({
      config: SETTINGS_FIXTURE,
      hasLeadingOption: false,
      query: 'gpt-5'
    }),
    {
      providers: [
        {
          name: 'OpenAI',
          type: 'openai',
          models: ['gpt-5', 'gpt-5-mini']
        }
      ],
      showEmptyState: false,
      showLeadingOption: false
    }
  )
})
