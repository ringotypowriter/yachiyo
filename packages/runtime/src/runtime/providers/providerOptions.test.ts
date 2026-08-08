import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderSettings } from '@yachiyo/shared/protocol'
import { createProviderOptions } from './providerOptions.ts'

function settings(input: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    providerName: 'work',
    provider: 'openai',
    model: 'gpt-5',
    thinkingEnabled: true,
    apiKey: 'sk-test',
    baseUrl: 'https://api.openai.com/v1',
    ...input
  }
}

test('createProviderOptions uses the requested OpenAI reasoning effort', () => {
  const options = createProviderOptions(settings(), 'default', 'high')

  assert.deepEqual(options, {
    openai: {
      reasoningEffort: 'high',
      reasoningSummary: 'detailed',
      textVerbosity: 'low',
      include: ['reasoning.encrypted_content'],
      store: false
    }
  })
})

test('createProviderOptions omits provider thinking params when reasoning is off', () => {
  const options = createProviderOptions(settings(), 'default', 'off')

  assert.deepEqual(options, {
    openai: {
      textVerbosity: 'low',
      include: ['reasoning.encrypted_content'],
      store: false
    }
  })
})

test('createProviderOptions enables priority processing for Codex Fast mode', () => {
  const options = createProviderOptions(
    settings({ provider: 'openai-codex', codexFastMode: true }),
    'default',
    'high',
    'priority'
  )

  assert.deepEqual(options, {
    openai: {
      reasoningEffort: 'high',
      reasoningSummary: 'detailed',
      serviceTier: 'priority',
      textVerbosity: 'low',
      include: ['reasoning.encrypted_content'],
      store: false
    }
  })
})

test('createProviderOptions keeps Codex calls Standard unless priority processing is explicit', () => {
  const options = createProviderOptions(
    settings({ provider: 'openai-codex', codexFastMode: true }),
    'default',
    'high'
  )

  assert.equal('openai' in options && 'serviceTier' in options.openai, false)
})

test('createProviderOptions keeps Codex Fast mode off by default', () => {
  const omitted = createProviderOptions(settings({ provider: 'openai-codex' }), 'default', 'high')
  const disabled = createProviderOptions(
    settings({ provider: 'openai-codex', codexFastMode: false }),
    'default',
    'high'
  )

  assert.equal('openai' in omitted && 'serviceTier' in omitted.openai, false)
  assert.equal('openai' in disabled && 'serviceTier' in disabled.openai, false)
})

test('createProviderOptions rejects OpenAI max reasoning effort', () => {
  assert.throws(
    () => createProviderOptions(settings(), 'default', 'max'),
    /OpenAI reasoning effort "max" is not supported/
  )
})

test('createProviderOptions rejects xhigh for OpenAI models without xhigh support', () => {
  assert.throws(
    () => createProviderOptions(settings({ model: 'gpt-5' }), 'default', 'xhigh'),
    /OpenAI reasoning effort "xhigh" is not supported/
  )
})

test('createProviderOptions allows xhigh for newer OpenAI GPT models', () => {
  for (const model of ['gpt-5.3-codex', 'gpt-5.4', 'gpt-5.5', 'gpt-5.6', 'gpt-5-6-codex']) {
    const options = createProviderOptions(settings({ model }), 'default', 'xhigh')

    assert.deepEqual(options, {
      openai: {
        reasoningEffort: 'xhigh',
        reasoningSummary: 'detailed',
        textVerbosity: 'low',
        include: ['reasoning.encrypted_content'],
        store: false
      }
    })
  }
})

test('createProviderOptions maps Anthropic high to a larger thinking budget', () => {
  const options = createProviderOptions(
    settings({
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      baseUrl: 'https://api.anthropic.com/v1'
    }),
    'default',
    'high'
  )

  assert.deepEqual(options, {
    anthropic: {
      thinking: {
        type: 'enabled',
        budgetTokens: 16000
      }
    }
  })
})
