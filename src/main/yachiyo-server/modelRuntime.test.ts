import assert from 'node:assert/strict'
import test from 'node:test'

import { createAiSdkModelRuntime } from './modelRuntime.ts'

test('createAiSdkModelRuntime uses AI SDK streaming with the OpenAI provider', async () => {
  let openAiOptions: { apiKey?: string; baseURL?: string } | undefined
  let selectedModel: { provider: string; modelId: string } | null = null
  let call: { abortSignal?: AbortSignal; messages: unknown } | null = null

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: (options) => {
      openAiOptions = options
      return {
        chat: (modelId: string) => {
          selectedModel = { modelId, provider: 'openai' }
          return { modelId, provider: 'openai' } as never
        },
      } as never
    },
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: ((input: { abortSignal?: AbortSignal; messages: unknown }) => {
      call = {
        abortSignal: input.abortSignal,
        messages: input.messages,
      }
      return {
        textStream: (async function* () {
          yield 'Hel'
          yield 'lo'
        })(),
      }
    }) as never,
  })

  const controller = new AbortController()
  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [
      { role: 'system', content: 'You are concise.' },
      { role: 'user', content: 'Say hello' },
    ],
    settings: {
      providerName: 'work',
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'sk-test',
      baseUrl: '',
    },
    signal: controller.signal,
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['Hel', 'lo'])
  assert.deepEqual(openAiOptions, {
    apiKey: 'sk-test',
    baseURL: 'https://api.openai.com/v1',
  })
  assert.deepEqual(selectedModel, {
    provider: 'openai',
    modelId: 'gpt-5',
  })
  const streamCall = call as { abortSignal?: AbortSignal; messages: unknown } | null
  if (streamCall === null) {
    assert.fail('Expected streamText to be called.')
  }
  assert.equal(streamCall.abortSignal, controller.signal)
})
