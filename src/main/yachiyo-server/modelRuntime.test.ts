import assert from 'node:assert/strict'
import test from 'node:test'

import { createAiSdkModelRuntime } from './modelRuntime.ts'

test('createAiSdkModelRuntime uses AI SDK streaming with the OpenAI responses provider', async () => {
  let openAiOptions: { apiKey?: string; baseURL?: string } | undefined
  let selectedModel: { provider: string; modelId: string } | null = null
  let call:
    | {
        abortSignal?: AbortSignal
        messages: unknown
        providerOptions?: {
          openai?: {
            reasoningEffort?: string
          }
        }
      }
    | null = null

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: (options) => {
      openAiOptions = options
      return {
        responses: (modelId: string) => {
          selectedModel = { modelId, provider: 'openai.responses' }
          return { modelId, provider: 'openai.responses' } as never
        }
      } as never
    },
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: ((input: {
      abortSignal?: AbortSignal
      messages: unknown
      providerOptions?: {
        openai?: {
          reasoningEffort?: string
        }
      }
    }) => {
      call = {
        abortSignal: input.abortSignal,
        messages: input.messages,
        providerOptions: input.providerOptions
      }
      return {
        textStream: (async function* () {
          yield 'Hel'
          yield 'lo'
        })()
      }
    }) as never
  })

  const controller = new AbortController()
  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'Say hello' }
    ],
    settings: {
      providerName: 'work',
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'sk-test',
      baseUrl: ''
    },
    signal: controller.signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['Hel', 'lo'])
  assert.deepEqual(openAiOptions, {
    apiKey: 'sk-test',
    baseURL: 'https://api.openai.com/v1'
  })
  assert.deepEqual(selectedModel, {
    provider: 'openai.responses',
    modelId: 'gpt-5'
  })
  const streamCall = call as
    | {
        abortSignal?: AbortSignal
        messages: unknown
        providerOptions?: {
          openai?: {
            reasoningEffort?: string
          }
        }
      }
    | null
  if (streamCall === null) {
    assert.fail('Expected streamText to be called.')
  }
  assert.equal(streamCall.abortSignal, controller.signal)
  assert.deepEqual(streamCall.providerOptions, {
    openai: {
      reasoningEffort: 'medium'
    }
  })
})

test('createAiSdkModelRuntime uses AI SDK streaming with Anthropic thinking enabled', async () => {
  let anthropicOptions: { apiKey?: string; baseURL?: string } | undefined
  let selectedModel: { provider: string; modelId: string } | null = null
  let call:
    | {
        abortSignal?: AbortSignal
        messages: unknown
        providerOptions?: {
          anthropic?: {
            thinking?: {
              type?: string
              budgetTokens?: number
            }
          }
        }
      }
    | null = null

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () => {
      throw new Error('OpenAI should not be used in this test.')
    },
    createAnthropicProvider: (options) => {
      anthropicOptions = options
      return ((modelId: string) => {
        selectedModel = { modelId, provider: 'anthropic' }
        return { modelId, provider: 'anthropic' } as never
      }) as never
    },
    streamTextImpl: ((input: {
      abortSignal?: AbortSignal
      messages: unknown
      providerOptions?: {
        anthropic?: {
          thinking?: {
            type?: string
            budgetTokens?: number
          }
        }
      }
    }) => {
      call = {
        abortSignal: input.abortSignal,
        messages: input.messages,
        providerOptions: input.providerOptions
      }
      return {
        textStream: (async function* () {
          yield 'Hi'
        })()
      }
    }) as never
  })

  const controller = new AbortController()
  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'Say hi' }
    ],
    settings: {
      providerName: 'claude',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'sk-ant-test',
      baseUrl: ''
    },
    signal: controller.signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['Hi'])
  assert.deepEqual(anthropicOptions, {
    apiKey: 'sk-ant-test',
    baseURL: 'https://api.anthropic.com/v1'
  })
  assert.deepEqual(selectedModel, {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5'
  })
  const streamCall = call as
    | {
        abortSignal?: AbortSignal
        messages: unknown
        providerOptions?: {
          anthropic?: {
            thinking?: {
              type?: string
              budgetTokens?: number
            }
          }
        }
      }
    | null
  if (streamCall === null) {
    assert.fail('Expected streamText to be called.')
  }
  assert.equal(streamCall.abortSignal, controller.signal)
  assert.deepEqual(streamCall.providerOptions, {
    anthropic: {
      thinking: {
        type: 'enabled',
        budgetTokens: 1024
      }
    }
  })
})
