import assert from 'node:assert/strict'
import test from 'node:test'

import { syncToolModelWithProvider } from './providerConfig.ts'

test('syncToolModelWithProvider keeps a valid tool-model selection', () => {
  const synced = syncToolModelWithProvider(
    {
      mode: 'custom',
      providerId: 'provider-work',
      providerName: 'work',
      model: 'gpt-5-mini'
    },
    {
      id: 'provider-work-renamed',
      name: 'work-renamed',
      type: 'openai',
      apiKey: 'sk-openai',
      baseUrl: 'https://api.openai.com/v1',
      modelList: {
        enabled: ['gpt-5-mini', 'gpt-5'],
        disabled: []
      }
    }
  )

  assert.deepEqual(synced, {
    mode: 'custom',
    providerId: 'provider-work-renamed',
    providerName: 'work-renamed',
    model: 'gpt-5-mini'
  })
})

test('syncToolModelWithProvider replaces a stale tool-model model with the first available model', () => {
  const synced = syncToolModelWithProvider(
    {
      mode: 'custom',
      providerId: 'provider-work',
      providerName: 'work',
      model: 'gpt-5-mini'
    },
    {
      id: 'provider-work',
      name: 'work',
      type: 'openai',
      apiKey: 'sk-openai',
      baseUrl: 'https://api.openai.com/v1',
      modelList: {
        enabled: ['gpt-5'],
        disabled: ['gpt-4.1']
      }
    }
  )

  assert.deepEqual(synced, {
    mode: 'custom',
    providerId: 'provider-work',
    providerName: 'work',
    model: 'gpt-5'
  })
})
