import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderConfig } from './protocol.ts'
import {
  getReasoningSelectorState,
  normalizeProviderReasoningConfig,
  resolveReasoningSelection
} from './reasoningEffort.ts'

function provider(input: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'provider-work',
    name: 'work',
    type: 'openai',
    thinkingEnabled: true,
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    modelList: {
      enabled: ['custom-model'],
      disabled: []
    },
    ...input
  }
}

test('unknown models default to medium as the only selectable reasoning effort', () => {
  const state = getReasoningSelectorState({
    provider: provider(),
    model: 'custom-model'
  })

  assert.deepEqual(state.options, ['medium'])
  assert.equal(state.selected, 'medium')
})

test('deepseek v4 pro defaults to max and exposes off high max', () => {
  const state = getReasoningSelectorState({
    provider: provider({
      baseUrl: 'https://api.deepseek.com/v1',
      modelList: {
        enabled: ['deepseek-v4-pro'],
        disabled: []
      }
    }),
    model: 'deepseek-v4-pro'
  })

  assert.deepEqual(state.options, ['off', 'high', 'max'])
  assert.equal(state.selected, 'max')
})

test('model reasoning overrides remove disabled efforts from the composer selection', () => {
  const state = getReasoningSelectorState({
    provider: provider({
      reasoning: {
        models: [
          {
            model: 'custom-model',
            enabledEfforts: ['low', 'high'],
            defaultEffort: 'high'
          }
        ]
      }
    }),
    model: 'custom-model',
    selected: 'max'
  })

  assert.deepEqual(state.options, ['low', 'high'])
  assert.equal(state.selected, 'high')
})

test('openai gpt models without xhigh support cannot select xhigh from overrides', () => {
  const state = getReasoningSelectorState({
    provider: provider({
      reasoning: {
        models: [
          {
            model: 'gpt-5',
            enabledEfforts: ['high', 'xhigh'],
            defaultEffort: 'xhigh'
          }
        ]
      }
    }),
    model: 'gpt-5',
    selected: 'xhigh'
  })

  assert.deepEqual(state.options, ['high'])
  assert.equal(state.selected, 'high')
})

test('newer openai gpt models can select xhigh from overrides', () => {
  for (const model of ['gpt-5.3-codex', 'gpt-5.4', 'gpt-5.5']) {
    const state = getReasoningSelectorState({
      provider: provider({
        reasoning: {
          models: [
            {
              model,
              enabledEfforts: ['high', 'xhigh', 'max'],
              defaultEffort: 'xhigh'
            }
          ]
        }
      }),
      model
    })

    assert.deepEqual(state.options, ['high', 'xhigh'])
    assert.equal(state.selected, 'xhigh')
  }
})

test('disabled provider thinking only allows off', () => {
  const state = getReasoningSelectorState({
    provider: provider({ thinkingEnabled: false }),
    model: 'custom-model',
    selected: 'medium'
  })

  assert.deepEqual(state.options, ['off'])
  assert.equal(state.selected, 'off')
})

test('runtime rejects stale selected reasoning efforts that are not enabled for the model', () => {
  assert.throws(
    () =>
      resolveReasoningSelection({
        provider: provider({
          reasoning: {
            models: [
              {
                model: 'custom-model',
                enabledEfforts: ['medium'],
                defaultEffort: 'medium'
              }
            ]
          }
        }),
        model: 'custom-model',
        requested: 'max'
      }),
    /Reasoning effort "max" is not available/
  )
})

test('model overrides cannot enable max for models without max support', () => {
  const state = getReasoningSelectorState({
    provider: provider({
      reasoning: {
        models: [
          {
            model: 'gpt-5',
            enabledEfforts: ['high', 'max'],
            defaultEffort: 'max'
          }
        ]
      }
    }),
    model: 'gpt-5',
    selected: 'max'
  })

  assert.deepEqual(state.options, ['high'])
  assert.equal(state.selected, 'high')
})

test('claude opus 4.7 can expose max when configured', () => {
  const state = getReasoningSelectorState({
    provider: provider({
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      reasoning: {
        models: [
          {
            model: 'claude-opus-4.7',
            enabledEfforts: ['high', 'max'],
            defaultEffort: 'max'
          }
        ]
      }
    }),
    model: 'claude-opus-4.7'
  })

  assert.deepEqual(state.options, ['high', 'max'])
  assert.equal(state.selected, 'max')
})

test('normalizes invalid reasoning defaults back to medium', () => {
  assert.deepEqual(
    normalizeProviderReasoningConfig({
      models: [
        {
          model: 'custom-model',
          enabledEfforts: ['medium'],
          defaultEffort: 'max'
        }
      ]
    }),
    {
      models: [
        {
          model: 'custom-model',
          enabledEfforts: ['medium'],
          defaultEffort: 'medium'
        }
      ]
    }
  )
})
