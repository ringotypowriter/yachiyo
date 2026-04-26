import assert from 'node:assert/strict'
import test from 'node:test'

import { createDeepSeekV4ProMaxEffortFetch } from './deepseekMaxEffort.ts'
import { createAnthropicLanguageModel } from './anthropic.ts'
import { createOpenAiLanguageModel } from './openai.ts'

test('createDeepSeekV4ProMaxEffortFetch adds reasoning_effort for OpenAI chat completions', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const wrappedFetch = createDeepSeekV4ProMaxEffortFetch(
    { model: 'custom/deepseek-v4-pro', provider: 'openai' },
    async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>
      return new Response('{}')
    }
  )

  await wrappedFetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'custom/deepseek-v4-pro', messages: [] })
  })

  assert.deepEqual(capturedBody, {
    model: 'custom/deepseek-v4-pro',
    messages: [],
    reasoning_effort: 'max'
  })
})

test('createDeepSeekV4ProMaxEffortFetch leaves OpenAI responses requests unchanged', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const wrappedFetch = createDeepSeekV4ProMaxEffortFetch(
    { model: 'deepseek-v4-pro', provider: 'openai' },
    async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>
      return new Response('{}')
    }
  )

  await wrappedFetch('https://api.deepseek.com/v1/responses', {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek-v4-pro', input: 'hello' })
  })

  assert.deepEqual(capturedBody, {
    model: 'deepseek-v4-pro',
    input: 'hello'
  })
})

test('createDeepSeekV4ProMaxEffortFetch adds output_config effort for Anthropic messages', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const wrappedFetch = createDeepSeekV4ProMaxEffortFetch(
    { model: 'deepseek-v4-pro', provider: 'anthropic' },
    async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>
      return new Response('{}')
    }
  )

  await wrappedFetch('https://api.deepseek.com/anthropic/messages', {
    method: 'POST',
    body: JSON.stringify({
      model: 'deepseek-v4-pro',
      messages: [],
      output_config: { format: 'text' }
    })
  })

  assert.deepEqual(capturedBody, {
    model: 'deepseek-v4-pro',
    messages: [],
    output_config: { format: 'text', effort: 'max' }
  })
})

test('createDeepSeekV4ProMaxEffortFetch ignores non-matching model names', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const wrappedFetch = createDeepSeekV4ProMaxEffortFetch(
    { model: 'deepseek-v4', provider: 'openai' },
    async (_input, init) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>
      return new Response('{}')
    }
  )

  await wrappedFetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek-v4', messages: [] })
  })

  assert.deepEqual(capturedBody, {
    model: 'deepseek-v4',
    messages: []
  })
})

test('createDeepSeekV4ProMaxEffortFetch respects disabled thinking', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const baseFetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>
    return new Response('{}')
  }
  const wrappedFetch = createDeepSeekV4ProMaxEffortFetch(
    { model: 'deepseek-v4-pro', provider: 'openai', thinkingEnabled: false },
    baseFetch
  )

  await wrappedFetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [] })
  })

  assert.equal(wrappedFetch, baseFetch)
  assert.deepEqual(capturedBody, {
    model: 'deepseek-v4-pro',
    messages: []
  })
})

test('createOpenAiLanguageModel installs max-effort fetch for deepseek-v4-pro chat requests', async () => {
  let openAiOptions:
    | {
        fetch?: typeof globalThis.fetch
      }
    | undefined
  let capturedBody: Record<string, unknown> | undefined
  const transport = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>
    return new Response('{}')
  }

  createOpenAiLanguageModel(
    {
      providerName: 'deepseek',
      provider: 'openai',
      model: 'vendor/deepseek-v4-pro',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1'
    },
    {
      createOpenAIProvider: (options) => {
        openAiOptions = options
        return {
          chat: (modelId: string) => ({ modelId, provider: 'openai.chat' }),
          responses: (modelId: string) => ({ modelId, provider: 'openai.responses' })
        } as never
      }
    } as never,
    'default',
    transport as typeof globalThis.fetch
  )

  assert.ok(openAiOptions?.fetch)
  await openAiOptions.fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'vendor/deepseek-v4-pro', messages: [] })
  })
  assert.equal(capturedBody?.reasoning_effort, 'max')
})

test('createOpenAiLanguageModel skips max-effort fetch when thinking is disabled', () => {
  let openAiOptions:
    | {
        fetch?: typeof globalThis.fetch
      }
    | undefined

  createOpenAiLanguageModel(
    {
      providerName: 'deepseek',
      provider: 'openai',
      model: 'deepseek-v4-pro',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1',
      thinkingEnabled: false
    },
    {
      createOpenAIProvider: (options) => {
        openAiOptions = options
        return {
          chat: (modelId: string) => ({ modelId, provider: 'openai.chat' }),
          responses: (modelId: string) => ({ modelId, provider: 'openai.responses' })
        } as never
      }
    } as never,
    'default'
  )

  assert.equal(openAiOptions?.fetch, undefined)
})

test('createAnthropicLanguageModel installs max-effort fetch for deepseek-v4-pro messages requests', async () => {
  let anthropicOptions:
    | {
        fetch?: typeof globalThis.fetch
      }
    | undefined
  let capturedBody: Record<string, unknown> | undefined
  const transport = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>
    return new Response('{}')
  }

  createAnthropicLanguageModel(
    {
      providerName: 'deepseek',
      provider: 'anthropic',
      model: 'deepseek-v4-pro',
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.deepseek.com/anthropic'
    },
    {
      createAnthropicProvider: (options) => {
        anthropicOptions = options
        return ((modelId: string) => ({ modelId, provider: 'anthropic' })) as never
      },
      fetchImpl: transport
    } as never
  )

  assert.ok(anthropicOptions?.fetch)
  await anthropicOptions.fetch('https://api.deepseek.com/anthropic/messages', {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [] })
  })
  assert.deepEqual(capturedBody?.output_config, { effort: 'max' })
})

test('createAnthropicLanguageModel skips max-effort fetch when thinking is disabled', () => {
  let anthropicOptions:
    | {
        fetch?: typeof globalThis.fetch
      }
    | undefined

  createAnthropicLanguageModel(
    {
      providerName: 'deepseek',
      provider: 'anthropic',
      model: 'deepseek-v4-pro',
      apiKey: 'sk-ant-test',
      baseUrl: 'https://api.deepseek.com/anthropic',
      thinkingEnabled: false
    },
    {
      createAnthropicProvider: (options) => {
        anthropicOptions = options
        return ((modelId: string) => ({ modelId, provider: 'anthropic' })) as never
      },
      fetchImpl: async (): Promise<Response> => new Response('{}')
    } as never
  )

  assert.equal(anthropicOptions?.fetch, undefined)
})
