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

test('createProviderOptions uses adaptive thinking for models that reject token budgets', () => {
  for (const model of [
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-mythos-5-1',
    'claude-mythos-5',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-7'
  ]) {
    const options = createProviderOptions(
      settings({ provider: 'anthropic', model, baseUrl: 'https://api.anthropic.com/v1' }),
      'default',
      'high'
    )

    assert.deepEqual(
      options,
      { anthropic: { thinking: { type: 'adaptive' }, effort: 'high' } },
      model
    )
  }
})

test('createProviderOptions forwards adaptive effort overrides and defaults to medium', () => {
  const provider = settings({
    provider: 'anthropic',
    model: 'claude-fable-5-1',
    baseUrl: '',
    reasoningEffort: 'low'
  })
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    assert.deepEqual(createProviderOptions(provider, 'default', effort), {
      anthropic: { thinking: { type: 'adaptive' }, effort }
    })
  }
  assert.deepEqual(createProviderOptions(provider), {
    anthropic: { thinking: { type: 'adaptive' }, effort: 'low' }
  })
  assert.deepEqual(createProviderOptions({ ...provider, reasoningEffort: undefined }), {
    anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' }
  })
})

test('createProviderOptions uses low effort when always-on thinking cannot be disabled', () => {
  for (const model of [
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-mythos-5-1',
    'claude-mythos-5',
    'claude-opus-5-5',
    'claude-sonnet-5-5'
  ]) {
    const provider = settings({
      provider: 'anthropic',
      model,
      baseUrl: 'https://api.anthropic.com/v1',
      reasoningEffort: 'high'
    })
    const expected = { anthropic: { thinking: { type: 'adaptive' }, effort: 'low' } }

    assert.deepEqual(createProviderOptions(provider, 'default', 'off'), expected, model)
    assert.deepEqual(
      createProviderOptions({ ...provider, thinkingEnabled: false }),
      expected,
      model
    )
    assert.deepEqual(createProviderOptions(provider, 'auxiliary'), expected, model)
  }
})

test('createProviderOptions still disables thinking on models that support it', () => {
  for (const model of [
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-5-5',
    'claude-sonnet-4-5',
    'deepseek-v4-pro',
    'kimi-k2.5'
  ]) {
    const provider = settings({ provider: 'anthropic', model, reasoningEffort: 'max' })
    const expected = { anthropic: { thinking: { type: 'disabled' } } }

    assert.deepEqual(createProviderOptions(provider, 'default', 'off'), expected, model)
    assert.deepEqual(
      createProviderOptions({ ...provider, thinkingEnabled: false }),
      expected,
      model
    )
    assert.deepEqual(createProviderOptions(provider, 'auxiliary'), expected, model)
  }
})

test('createProviderOptions preserves budgets for older Claude and compatible models', () => {
  for (const model of [
    'claude-sonnet-4-5',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'deepseek-v4-pro',
    'kimi-k2.5',
    'custom-model'
  ]) {
    assert.deepEqual(
      createProviderOptions(settings({ provider: 'anthropic', model }), 'default', 'high'),
      { anthropic: { thinking: { type: 'enabled', budgetTokens: 16000 } } },
      model
    )
  }
})
