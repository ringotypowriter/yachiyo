import assert from 'node:assert/strict'
import test from 'node:test'

import { filterProviderModels, toggleProviderModel } from './providersPaneModel.ts'

test('filterProviderModels returns all models for an empty query', () => {
  assert.deepEqual(
    filterProviderModels(
      {
        enabled: ['gpt-5', 'claude-sonnet-4'],
        disabled: ['gpt-5-mini']
      },
      ''
    ),
    {
      enabled: ['gpt-5', 'claude-sonnet-4'],
      disabled: ['gpt-5-mini']
    }
  )
})

test('filterProviderModels matches enabled and disabled models case-insensitively', () => {
  assert.deepEqual(
    filterProviderModels(
      {
        enabled: ['gpt-5', 'claude-sonnet-4'],
        disabled: ['gpt-5-mini', 'gemini-2.5-pro']
      },
      'GPT'
    ),
    {
      enabled: ['gpt-5'],
      disabled: ['gpt-5-mini']
    }
  )
})

test('filterProviderModels excludes non-matching models', () => {
  assert.deepEqual(
    filterProviderModels(
      {
        enabled: ['gpt-5'],
        disabled: ['claude-sonnet-4']
      },
      'missing'
    ),
    {
      enabled: [],
      disabled: []
    }
  )
})

test('toggleProviderModel preserves image capability overrides when enabling a model', () => {
  assert.deepEqual(
    toggleProviderModel(
      {
        enabled: [],
        disabled: ['deepseek-chat'],
        imageIncapable: ['deepseek-chat']
      },
      'deepseek-chat'
    ),
    {
      enabled: ['deepseek-chat'],
      disabled: [],
      imageIncapable: ['deepseek-chat']
    }
  )
})
