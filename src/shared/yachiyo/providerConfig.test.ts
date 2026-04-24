import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeImageIncapableForNewModels,
  isKnownImageIncapableModel,
  isModelImageCapable,
  sanitizeProviderConfig,
  syncToolModelWithProvider
} from './providerConfig.ts'

test('sanitizeProviderConfig preserves spaces while editing a provider name', () => {
  const sanitized = sanitizeProviderConfig({
    id: 'provider-work',
    name: 'OpenAI Work ',
    type: 'openai',
    apiKey: ' sk-openai ',
    baseUrl: ' https://api.openai.com/v1 ',
    modelList: {
      enabled: ['gpt-5'],
      disabled: []
    }
  })

  assert.equal(sanitized.name, 'OpenAI Work ')
  assert.equal(sanitized.apiKey, 'sk-openai')
  assert.equal(sanitized.baseUrl, 'https://api.openai.com/v1')
})

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

test('isModelImageCapable returns true by default', () => {
  const config = {
    providers: [
      {
        name: 'work',
        type: 'openai' as const,
        apiKey: '',
        baseUrl: '',
        modelList: { enabled: ['gpt-5'], disabled: [] }
      }
    ]
  }
  assert.equal(isModelImageCapable(config, 'work', 'gpt-5'), true)
})

test('isModelImageCapable returns false for denylisted model', () => {
  const config = {
    providers: [
      {
        name: 'work',
        type: 'openai' as const,
        apiKey: '',
        baseUrl: '',
        modelList: {
          enabled: ['gpt-5', 'gpt-5-mini'],
          disabled: [],
          imageIncapable: ['gpt-5-mini']
        }
      }
    ]
  }
  assert.equal(isModelImageCapable(config, 'work', 'gpt-5'), true)
  assert.equal(isModelImageCapable(config, 'work', 'gpt-5-mini'), false)
})

test('isModelImageCapable returns true for unknown provider or model', () => {
  const config = {
    providers: [
      {
        name: 'work',
        type: 'openai' as const,
        apiKey: '',
        baseUrl: '',
        modelList: { enabled: ['gpt-5'], disabled: [], imageIncapable: ['gpt-5'] }
      }
    ]
  }
  assert.equal(isModelImageCapable(config, 'unknown-provider', 'gpt-5'), true)
  assert.equal(isModelImageCapable(config, 'work', 'unknown-model'), true)
})

test('sanitizeProviderConfig preserves imageIncapable list', () => {
  const sanitized = sanitizeProviderConfig({
    name: 'work',
    type: 'openai',
    apiKey: '',
    baseUrl: '',
    modelList: {
      enabled: ['gpt-5', 'gpt-5-mini'],
      disabled: [],
      imageIncapable: ['gpt-5-mini', '', 'gpt-5-mini']
    }
  })
  assert.deepEqual(sanitized.modelList.imageIncapable, ['gpt-5-mini'])
})

test('isKnownImageIncapableModel matches known text-only models', () => {
  assert.equal(isKnownImageIncapableModel('deepseek-chat'), true)
  assert.equal(isKnownImageIncapableModel('deepseek-r1-0528'), true)
  assert.equal(isKnownImageIncapableModel('DeepSeek-V3'), true)
  assert.equal(isKnownImageIncapableModel('codestral-latest'), true)
  assert.equal(isKnownImageIncapableModel('qwq-32b'), true)
  assert.equal(isKnownImageIncapableModel('gemma-2-27b'), true)
  assert.equal(isKnownImageIncapableModel('gpt-3.5-turbo'), true)
})

test('isKnownImageIncapableModel does not match vision-capable models', () => {
  assert.equal(isKnownImageIncapableModel('gpt-4o'), false)
  assert.equal(isKnownImageIncapableModel('claude-sonnet-4-20250514'), false)
  assert.equal(isKnownImageIncapableModel('gemini-2.5-pro'), false)
  assert.equal(isKnownImageIncapableModel('pixtral-large-latest'), false)
  assert.equal(isKnownImageIncapableModel('qwen2-vl-72b'), false)
})

test('computeImageIncapableForNewModels auto-flags known text-only models', () => {
  const result = computeImageIncapableForNewModels(
    undefined,
    ['gpt-4o'],
    ['deepseek-chat', 'gpt-4o-mini']
  )
  assert.deepEqual(result, ['deepseek-chat'])
})

test('computeImageIncapableForNewModels preserves existing flags and skips known models already listed', () => {
  const result = computeImageIncapableForNewModels(
    ['deepseek-chat'],
    ['deepseek-chat'],
    ['deepseek-r1', 'gpt-4o']
  )
  assert.deepEqual(result, ['deepseek-chat', 'deepseek-r1'])
})

test('computeImageIncapableForNewModels returns undefined when no matches', () => {
  const result = computeImageIncapableForNewModels(
    undefined,
    [],
    ['gpt-4o', 'claude-sonnet-4-20250514']
  )
  assert.equal(result, undefined)
})
