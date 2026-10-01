import assert from 'node:assert/strict'
import test from 'node:test'

import type { SettingsConfig } from '@yachiyo/shared/protocol'
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

test('puts the selected model provider first without changing other providers or model order', () => {
  const config: SettingsConfig = {
    providers: [
      {
        ...SETTINGS_FIXTURE.providers[0],
        name: 'Packycode',
        modelList: { enabled: ['a', 'b'], disabled: [] }
      },
      {
        ...SETTINGS_FIXTURE.providers[0],
        name: 'Other',
        modelList: { enabled: ['c'], disabled: [] }
      },
      { ...SETTINGS_FIXTURE.providers[0], name: 'OpenAI (Codex OAuth)' }
    ]
  }

  assert.deepEqual(
    resolveModelSelectorState({
      config,
      hasLeadingOption: false,
      query: '',
      currentProviderName: 'OpenAI (Codex OAuth)',
      currentModel: 'gpt-5-mini'
    }).providers.map(({ name, models }) => ({ name, models })),
    [
      { name: 'OpenAI (Codex OAuth)', models: ['gpt-5', 'gpt-5-mini'] },
      { name: 'Packycode', models: ['a', 'b'] },
      { name: 'Other', models: ['c'] }
    ]
  )
})

test('puts the selected provider first when search hides its selected model', () => {
  const config: SettingsConfig = {
    providers: [
      {
        ...SETTINGS_FIXTURE.providers[0],
        name: 'First',
        modelList: { enabled: ['gpt-5'], disabled: [] }
      },
      {
        ...SETTINGS_FIXTURE.providers[0],
        name: 'OpenAI',
        modelList: { enabled: ['gpt-5', 'mini'], disabled: [] }
      }
    ]
  }

  assert.deepEqual(
    resolveModelSelectorState({
      config,
      hasLeadingOption: false,
      query: 'gpt',
      currentProviderName: 'OpenAI',
      currentModel: 'mini'
    }).providers.map(({ name }) => name),
    ['OpenAI', 'First']
  )
})

test('hides ACP agents while subagents are in worker mode', () => {
  assert.deepEqual(
    resolveModelSelectorState({
      config: {
        ...SETTINGS_FIXTURE,
        subagents: { mode: 'worker', enabledNamedAgents: [] },
        subagentProfiles: [
          {
            id: 'agent-1',
            name: 'Claude Code',
            enabled: true,
            showInChatPicker: true,
            description: 'Deprecated ACP agent',
            command: 'npx',
            args: [],
            env: {}
          }
        ]
      },
      hasLeadingOption: false,
      query: 'Claude'
    }).acpAgents,
    []
  )
})

test('shows ACP agents only in deprecated ACP mode', () => {
  assert.deepEqual(
    resolveModelSelectorState({
      config: {
        ...SETTINGS_FIXTURE,
        subagents: { mode: 'acp', enabledNamedAgents: [] },
        subagentProfiles: [
          {
            id: 'agent-1',
            name: 'Claude Code',
            enabled: true,
            showInChatPicker: true,
            description: 'Deprecated ACP agent',
            command: 'npx',
            args: [],
            env: {}
          }
        ]
      },
      hasLeadingOption: false,
      query: 'Claude'
    }).acpAgents,
    [{ id: 'agent-1', name: 'Claude Code', description: 'Deprecated ACP agent' }]
  )
})
