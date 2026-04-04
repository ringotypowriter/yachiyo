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

test('keeps the tool-model picker reachable in default mode even without enabled models', () => {
  assert.equal(
    canOpenToolModelPicker({
      hasEnabledModels: false,
      toolModelMode: 'default'
    }),
    true
  )
})

test('hides leading options and shows empty state when search filters out every model', () => {
  assert.deepEqual(
    resolveModelSelectorState({
      config: SETTINGS_FIXTURE,
      hasLeadingOption: true,
      query: 'no-match'
    }),
    {
      providers: [],
      acpAgents: [],
      showEmptyState: true,
      showLeadingOption: false
    }
  )
})

test('shows leading options when there is no search query', () => {
  assert.deepEqual(
    resolveModelSelectorState({
      config: SETTINGS_FIXTURE,
      hasLeadingOption: true,
      query: ''
    }),
    {
      providers: [
        {
          name: 'OpenAI',
          type: 'openai',
          baseUrl: '',
          models: ['gpt-5', 'gpt-5-mini']
        }
      ],
      acpAgents: [],
      showEmptyState: false,
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
          baseUrl: '',
          models: ['gpt-5', 'gpt-5-mini']
        }
      ],
      acpAgents: [],
      showEmptyState: false,
      showLeadingOption: false
    }
  )
})
