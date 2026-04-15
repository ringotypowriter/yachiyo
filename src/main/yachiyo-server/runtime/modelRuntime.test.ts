import assert from 'node:assert/strict'
import test from 'node:test'

import { createAiSdkModelRuntime, fetchModels } from './modelRuntime.ts'

test('createAiSdkModelRuntime uses chat() for openai (Chat Completions) provider', async () => {
  let openAiOptions: { apiKey?: string; baseURL?: string } | undefined
  let selectedModel: { provider: string; modelId: string } | null = null
  let call: {
    abortSignal?: AbortSignal
    messages: unknown
    providerOptions?: {
      openai?: {
        store?: boolean
      }
    }
  } | null = null

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: (options) => {
      openAiOptions = options
      return {
        chat: (modelId: string) => {
          selectedModel = { modelId, provider: 'openai.chat' }
          return { modelId, provider: 'openai.chat' } as never
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
          store?: boolean
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
      model: 'gpt-4o',
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
  assert.deepEqual(selectedModel, { provider: 'openai.chat', modelId: 'gpt-4o' })
  const streamCall = call as {
    abortSignal?: AbortSignal
    messages: unknown
    providerOptions?: { openai?: { store?: boolean } }
  } | null
  if (streamCall === null) {
    assert.fail('Expected streamText to be called.')
  }
  assert.equal(streamCall.abortSignal, controller.signal)
  assert.deepEqual(streamCall.providerOptions, { openai: { store: false } })
})

test('createAiSdkModelRuntime uses responses() with reasoning for openai-responses provider', async () => {
  let openAiOptions: { apiKey?: string; baseURL?: string } | undefined
  let selectedModel: { provider: string; modelId: string } | null = null
  let call: {
    abortSignal?: AbortSignal
    messages: unknown
    providerOptions?: {
      openai?: {
        reasoningEffort?: string
        store?: boolean
      }
    }
  } | null = null

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
          store?: boolean
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
      provider: 'openai-responses',
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
  assert.deepEqual(selectedModel, { provider: 'openai.responses', modelId: 'gpt-5' })
  const streamCall = call as {
    abortSignal?: AbortSignal
    messages: unknown
    providerOptions?: { openai?: { reasoningEffort?: string; store?: boolean } }
  } | null
  if (streamCall === null) {
    assert.fail('Expected streamText to be called.')
  }
  assert.equal(streamCall.abortSignal, controller.signal)
  assert.deepEqual(streamCall.providerOptions, {
    openai: {
      reasoningEffort: 'medium',
      reasoningSummary: 'auto',
      textVerbosity: 'low',
      store: false
    }
  })
})

test('createAiSdkModelRuntime preserves legacy openai reasoning models', async () => {
  let selectedModel: { provider: string; modelId: string } | null = null
  let providerOptions:
    | {
        openai?: {
          reasoningEffort?: string
          store?: boolean
        }
      }
    | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        chat: () => {
          throw new Error('Legacy GPT-5 OpenAI providers should not use chat().')
        },
        responses: (modelId: string) => {
          selectedModel = { modelId, provider: 'openai.responses' }
          return { modelId, provider: 'openai.responses' }
        }
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: ((input: {
      providerOptions?: {
        openai?: {
          reasoningEffort?: string
          store?: boolean
        }
      }
    }) => {
      providerOptions = input.providerOptions
      return {
        textStream: (async function* () {
          yield 'ok'
        })()
      }
    }) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Think.' }],
    settings: {
      providerName: 'legacy-openai',
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'sk-test',
      baseUrl: ''
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['ok'])
  assert.deepEqual(selectedModel, { provider: 'openai.responses', modelId: 'gpt-5' })
  assert.deepEqual(providerOptions, {
    openai: {
      reasoningEffort: 'medium',
      reasoningSummary: 'auto',
      textVerbosity: 'low',
      store: false
    }
  })
})

test('createAiSdkModelRuntime forwards max_token as maxOutputTokens', async () => {
  let maxOutputTokens: number | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        chat: (modelId: string) => ({ modelId, provider: 'openai.chat' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: ((input: { maxOutputTokens?: number }) => {
      maxOutputTokens = input.maxOutputTokens
      return {
        textStream: (async function* () {
          yield 'ok'
        })()
      }
    }) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Limit this reply.' }],
    settings: {
      providerName: 'work',
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test',
      baseUrl: ''
    },
    signal: new AbortController().signal,
    max_token: 64
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['ok'])
  assert.equal(maxOutputTokens, 64)
})

test('createAiSdkModelRuntime caps gemini max_token to the model ceiling', async () => {
  let maxOutputTokens: number | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () => {
      throw new Error('OpenAI should not be used in this test.')
    },
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    createGoogleProvider: () => ((modelId: string) => ({ modelId, provider: 'google' })) as never,
    streamTextImpl: ((input: { maxOutputTokens?: number }) => {
      maxOutputTokens = input.maxOutputTokens
      return {
        textStream: (async function* () {
          yield 'ok'
        })()
      }
    }) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Limit this reply.' }],
    settings: {
      providerName: 'google-ai',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'AIza_test',
      baseUrl: ''
    },
    signal: new AbortController().signal,
    max_token: 64
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['ok'])
  assert.equal(maxOutputTokens, 65536)
})

test('createAiSdkModelRuntime uses AI SDK streaming with Anthropic thinking enabled', async () => {
  let anthropicOptions: { apiKey?: string; baseURL?: string } | undefined
  let selectedModel: { provider: string; modelId: string } | null = null
  let call: {
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
  } | null = null

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
  const streamCall = call as {
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
  } | null
  if (streamCall === null) {
    assert.fail('Expected streamText to be called.')
  }
  assert.equal(streamCall.abortSignal, controller.signal)
  assert.deepEqual(streamCall.providerOptions, {
    anthropic: {
      thinking: {
        type: 'enabled',
        budgetTokens: 8000
      }
    }
  })
})

test('createAiSdkModelRuntime uses Vercel AI Gateway with vertex provider options for Gemini', async () => {
  let gatewayOptions: { apiKey?: string; baseURL?: string } | undefined
  let selectedModel: { provider: string; modelId: string } | null = null
  let call: {
    abortSignal?: AbortSignal
    messages: unknown
    providerOptions?: {
      gateway?: {
        order?: string[]
      }
      vertex?: {
        thinkingConfig?: {
          includeThoughts?: boolean
          thinkingLevel?: string
        }
      }
    }
  } | null = null

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () => {
      throw new Error('OpenAI should not be used in this test.')
    },
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    createGatewayProvider: (options) => {
      gatewayOptions = options
      return ((modelId: string) => {
        selectedModel = { modelId, provider: 'gateway' }
        return { modelId, provider: 'gateway' } as never
      }) as never
    },
    streamTextImpl: ((input: {
      abortSignal?: AbortSignal
      messages: unknown
      providerOptions?: {
        gateway?: {
          order?: string[]
        }
        vertex?: {
          thinkingConfig?: {
            includeThoughts?: boolean
            thinkingLevel?: string
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
          yield 'Vertex'
        })()
      }
    }) as never
  })

  const controller = new AbortController()
  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Think carefully.' }],
    settings: {
      providerName: 'vercel-gateway-work',
      provider: 'vercel-gateway',
      model: 'google/gemini-3-flash',
      apiKey: 'vgw_test',
      baseUrl: 'https://ai-gateway.vercel.sh/v1'
    },
    signal: controller.signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['Vertex'])
  assert.equal(gatewayOptions?.apiKey, 'vgw_test')
  assert.equal(gatewayOptions?.baseURL, 'https://ai-gateway.vercel.sh/v3/ai')
  assert.deepEqual(selectedModel, {
    provider: 'gateway',
    modelId: 'google/gemini-3-flash'
  })
  const streamCall = call as {
    abortSignal?: AbortSignal
    messages: unknown
    providerOptions?: {
      gateway?: {
        order?: string[]
      }
      vertex?: {
        thinkingConfig?: {
          includeThoughts?: boolean
          thinkingLevel?: string
        }
      }
    }
  } | null
  if (streamCall === null) {
    assert.fail('Expected streamText to be called.')
  }
  assert.deepEqual(streamCall.providerOptions, {
    gateway: {
      order: ['vertex']
    },
    vertex: {
      thinkingConfig: {
        includeThoughts: true,
        thinkingLevel: 'medium'
      }
    }
  })
})

test('createAiSdkModelRuntime omits vercel-gateway thinking config for non-Gemini-3 models', async () => {
  let providerOptions:
    | {
        gateway?: {
          order?: string[]
        }
        vertex?: {
          thinkingConfig?: {
            includeThoughts?: boolean
            thinkingLevel?: string
          }
        }
      }
    | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () => {
      throw new Error('OpenAI should not be used in this test.')
    },
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    createGatewayProvider: () => ((modelId: string) => ({ modelId, provider: 'gateway' })) as never,
    streamTextImpl: ((input: {
      providerOptions?: {
        gateway?: {
          order?: string[]
        }
        vertex?: {
          thinkingConfig?: {
            includeThoughts?: boolean
            thinkingLevel?: string
          }
        }
      }
    }) => {
      providerOptions = input.providerOptions
      return {
        textStream: (async function* () {
          yield 'ok'
        })()
      }
    }) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Say hi' }],
    settings: {
      providerName: 'vercel-gateway-work',
      provider: 'vercel-gateway',
      model: 'google/gemini-2.5-flash',
      apiKey: 'vgw_test',
      baseUrl: ''
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['ok'])
  assert.deepEqual(providerOptions, {
    gateway: {
      order: ['vertex']
    }
  })
})

test('createAiSdkModelRuntime uses chat() for openai-responses auxiliary generation', async () => {
  let providerOptions:
    | {
        openai?: {
          reasoningEffort?: string
          store?: boolean
        }
      }
    | undefined
  let selectedModel: { provider: string; modelId: string } | null = null

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: () => {
          throw new Error('Responses API should not be used for auxiliary generation.')
        },
        chat: (modelId: string) => {
          selectedModel = { modelId, provider: 'openai.chat' }
          return { modelId, provider: 'openai.chat' }
        }
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: ((input: {
      providerOptions?: {
        openai?: {
          reasoningEffort?: string
          store?: boolean
        }
      }
    }) => {
      providerOptions = input.providerOptions
      return {
        textStream: (async function* () {
          yield 'title'
        })()
      }
    }) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Plan the MVP' }],
    providerOptionsMode: 'auxiliary',
    settings: {
      providerName: 'work',
      provider: 'openai-responses',
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      baseUrl: ''
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['title'])
  assert.deepEqual(selectedModel, {
    provider: 'openai.chat',
    modelId: 'gpt-5-mini'
  })
  assert.deepEqual(providerOptions, {
    openai: {
      textVerbosity: 'low',
      store: false
    }
  })
})

test('createAiSdkModelRuntime omits OpenAI reasoningEffort for non-reasoning models', async () => {
  let providerOptions:
    | {
        openai?: {
          reasoningEffort?: string
          store?: boolean
        }
      }
    | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: () => ({ modelId: 'qwen3.5-flash', provider: 'openai.responses' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: ((input: {
      providerOptions?: {
        openai?: {
          reasoningEffort?: string
          store?: boolean
        }
      }
    }) => {
      providerOptions = input.providerOptions
      return {
        textStream: (async function* () {
          yield 'ok'
        })()
      }
    }) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Say hi' }],
    settings: {
      providerName: 'work',
      provider: 'openai-responses',
      model: 'qwen3.5-flash',
      apiKey: 'sk-test',
      baseUrl: ''
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['ok'])
  assert.deepEqual(providerOptions, {
    openai: {
      store: false
    }
  })
})

test('createAiSdkModelRuntime disables OpenAI reasoning when provider thinking is off', async () => {
  let providerOptions:
    | {
        openai?: {
          reasoningEffort?: string
          store?: boolean
        }
      }
    | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: () => ({ modelId: 'gpt-5', provider: 'openai.responses' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: ((input: {
      providerOptions?: {
        openai?: {
          reasoningEffort?: string
          store?: boolean
        }
      }
    }) => {
      providerOptions = input.providerOptions
      return {
        textStream: (async function* () {
          yield 'ok'
        })()
      }
    }) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Think carefully.' }],
    settings: {
      providerName: 'work',
      provider: 'openai-responses',
      model: 'gpt-5',
      thinkingEnabled: false,
      apiKey: 'sk-test',
      baseUrl: ''
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['ok'])
  assert.deepEqual(providerOptions, {
    openai: {
      textVerbosity: 'low',
      store: false
    }
  })
})

test('createAiSdkModelRuntime forwards reasoning deltas from fullStream reasoning events', async () => {
  const reasoningDeltas: string[] = []

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: () => ({ modelId: 'gpt-5', provider: 'openai.responses' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: (() => ({
      fullStream: (async function* () {
        yield { type: 'reasoning-start', id: 'reasoning-1' }
        yield { type: 'reasoning-delta', id: 'reasoning-1', delta: 'first ' }
        yield { type: 'reasoning-delta', id: 'reasoning-1', delta: 'second' }
        yield { type: 'reasoning-end', id: 'reasoning-1' }
        yield { type: 'text-delta', id: 'text-1', delta: 'answer' }
      })()
    })) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Think carefully.' }],
    settings: {
      providerName: 'work',
      provider: 'openai-responses',
      model: 'gpt-5',
      apiKey: 'sk-test',
      baseUrl: ''
    },
    signal: new AbortController().signal,
    onReasoningDelta: (delta) => {
      reasoningDeltas.push(delta)
    }
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(reasoningDeltas, ['first ', 'second'])
  assert.deepEqual(chunks, ['answer'])
})

test('createAiSdkModelRuntime reports cache reads from totalUsage instead of final-step usage', async () => {
  let finishedUsage:
    | {
        promptTokens: number
        completionTokens: number
        totalPromptTokens: number
        totalCompletionTokens: number
        cacheReadTokens?: number
      }
    | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: () => ({ modelId: 'gpt-5', provider: 'openai.responses' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: (() => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 'text-1', text: 'answer' }
      })(),
      usage: Promise.resolve({
        inputTokens: 200,
        outputTokens: 50,
        inputTokenDetails: {
          cacheReadTokens: 0
        }
      }),
      totalUsage: Promise.resolve({
        inputTokens: 1200,
        outputTokens: 150,
        inputTokenDetails: {
          cacheReadTokens: 600
        }
      }),
      finishReason: Promise.resolve('stop')
    })) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Think carefully.' }],
    settings: {
      providerName: 'work',
      provider: 'openai-responses',
      model: 'gpt-5',
      apiKey: 'sk-test',
      baseUrl: ''
    },
    signal: new AbortController().signal,
    onFinish: (usage) => {
      finishedUsage = usage
    }
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['answer'])
  assert.deepEqual(finishedUsage, {
    promptTokens: 200,
    completionTokens: 50,
    totalPromptTokens: 1200,
    totalCompletionTokens: 150,
    cacheReadTokens: 600,
    finishReason: 'stop'
  })
})

test('createAiSdkModelRuntime disables Anthropic thinking for auxiliary generation', async () => {
  let providerOptions:
    | {
        anthropic?: {
          thinking?: {
            type?: string
            budgetTokens?: number
          }
        }
      }
    | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () => {
      throw new Error('OpenAI should not be used in this test.')
    },
    createAnthropicProvider: () =>
      (() => ({ modelId: 'claude-sonnet-4-5', provider: 'anthropic' })) as never,
    streamTextImpl: ((input: {
      providerOptions?: {
        anthropic?: {
          thinking?: {
            type?: string
            budgetTokens?: number
          }
        }
      }
    }) => {
      providerOptions = input.providerOptions
      return {
        textStream: (async function* () {
          yield 'title'
        })()
      }
    }) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Plan the MVP' }],
    providerOptionsMode: 'auxiliary',
    settings: {
      providerName: 'claude',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKey: 'sk-ant-test',
      baseUrl: ''
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['title'])
  assert.deepEqual(providerOptions, {
    anthropic: {
      thinking: {
        type: 'disabled'
      }
    }
  })
})

test('createAiSdkModelRuntime disables Anthropic thinking when provider thinking is off', async () => {
  let providerOptions:
    | {
        anthropic?: {
          thinking?: {
            type?: string
            budgetTokens?: number
          }
        }
      }
    | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () => {
      throw new Error('OpenAI should not be used in this test.')
    },
    createAnthropicProvider: () =>
      (() => ({ modelId: 'claude-sonnet-4-5', provider: 'anthropic' })) as never,
    streamTextImpl: ((input: {
      providerOptions?: {
        anthropic?: {
          thinking?: {
            type?: string
            budgetTokens?: number
          }
        }
      }
    }) => {
      providerOptions = input.providerOptions
      return {
        textStream: (async function* () {
          yield 'ok'
        })()
      }
    }) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Think carefully.' }],
    settings: {
      providerName: 'claude',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      thinkingEnabled: false,
      apiKey: 'sk-ant-test',
      baseUrl: ''
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['ok'])
  assert.deepEqual(providerOptions, {
    anthropic: {
      thinking: {
        type: 'disabled'
      }
    }
  })
})

test('createAiSdkModelRuntime forwards tools and tool callbacks into the AI SDK tool loop', async () => {
  let call: {
    experimental_onToolCallFinish?: unknown
    experimental_onToolCallStart?: unknown
    stopWhen?: unknown
    tools?: unknown
  } | null = null

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: () => ({ modelId: 'gpt-5', provider: 'openai.responses' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: ((input: {
      experimental_onToolCallFinish?: unknown
      experimental_onToolCallStart?: unknown
      stopWhen?: unknown
      tools?: unknown
    }) => {
      call = input
      return {
        textStream: (async function* () {
          yield 'ok'
        })()
      }
    }) as never
  })

  const tools = { read: { description: 'read a file' } }
  const onToolCallStart = (): void => undefined
  let finishCalls = 0
  const onToolCallFinish = (): void => {
    finishCalls += 1
  }
  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'List the workspace files.' }],
    settings: {
      providerName: 'work',
      provider: 'openai-responses',
      model: 'gpt-5',
      apiKey: 'sk-test',
      baseUrl: ''
    },
    signal: new AbortController().signal,
    tools: tools as never,
    onToolCallStart: onToolCallStart as never,
    onToolCallFinish: onToolCallFinish as never
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['ok'])
  if (call === null) {
    assert.fail('Expected streamText to be called.')
  }
  const streamCall = call as {
    experimental_onToolCallFinish?: unknown
    experimental_onToolCallStart?: unknown
    stopWhen?: unknown
    tools?: unknown
  }
  assert.equal(streamCall.tools, tools)
  assert.equal(streamCall.experimental_onToolCallStart, onToolCallStart)
  assert.equal(typeof streamCall.experimental_onToolCallFinish, 'function')
  ;(streamCall.experimental_onToolCallFinish as (event: unknown) => void)({
    abortSignal: undefined,
    durationMs: 0,
    experimental_context: undefined,
    functionId: undefined,
    metadata: undefined,
    model: undefined,
    messages: [],
    stepNumber: undefined,
    success: true,
    output: { ok: true },
    toolCall: {
      type: 'tool-call',
      dynamic: true,
      toolCallId: 'tool-test-1',
      toolName: 'bash',
      input: { command: 'pwd' }
    }
  } as never)
  assert.equal(finishCalls, 1)
  assert.equal(typeof streamCall.stopWhen, 'function')
})

test('createAiSdkModelRuntime forwards preliminary tool results through onToolCallUpdate', async () => {
  const updates: Array<{
    output: unknown
    toolCall: {
      input: unknown
      toolCallId: string
      toolName: string
    }
  }> = []

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: () => ({ modelId: 'gpt-5', provider: 'openai.responses' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: (() => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 'text-1', text: 'He' }
        yield {
          type: 'tool-input-available',
          toolCallId: 'tool-bash-1',
          toolName: 'bash',
          input: { command: 'pwd' }
        }
        yield {
          type: 'tool-output-available',
          toolCallId: 'tool-bash-1',
          output: {
            content: [{ type: 'text', text: '/tmp/workspace\n' }],
            details: {
              command: 'pwd',
              cwd: '/tmp/workspace',
              stderr: '',
              stdout: '/tmp/workspace\n'
            },
            metadata: {
              cwd: '/tmp/workspace'
            }
          },
          preliminary: true
        }
        yield { type: 'text-delta', id: 'text-1', text: 'llo' }
      })()
    })) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'List the workspace files.' }],
    settings: {
      providerName: 'work',
      provider: 'openai-responses',
      model: 'gpt-5',
      apiKey: 'sk-test',
      baseUrl: ''
    },
    signal: new AbortController().signal,
    onToolCallUpdate: (event) => {
      updates.push({
        output: event.output,
        toolCall: {
          input: event.toolCall.input,
          toolCallId: event.toolCall.toolCallId,
          toolName: event.toolCall.toolName
        }
      })
    }
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['He', 'llo'])
  assert.deepEqual(updates, [
    {
      output: {
        content: [{ type: 'text', text: '/tmp/workspace\n' }],
        details: {
          command: 'pwd',
          cwd: '/tmp/workspace',
          stderr: '',
          stdout: '/tmp/workspace\n'
        },
        metadata: {
          cwd: '/tmp/workspace'
        }
      },
      toolCall: {
        input: { command: 'pwd' },
        toolCallId: 'tool-bash-1',
        toolName: 'bash'
      }
    }
  ])
})

test('createAiSdkModelRuntime forwards final tool results through onToolCallFinish when using fullStream', async () => {
  const updates: Array<{
    output: unknown
    toolCall: {
      input: unknown
      toolCallId: string
      toolName: string
    }
  }> = []
  const finishes: Array<{
    success: boolean
    output?: unknown
    toolCall: {
      input: unknown
      toolCallId: string
      toolName: string
    }
  }> = []

  const finalOutput = {
    content: [{ type: 'text', text: '/tmp/workspace\n' }],
    details: {
      command: 'pwd',
      cwd: '/tmp/workspace',
      exitCode: 0,
      stderr: '',
      stdout: '/tmp/workspace\n'
    },
    metadata: {
      cwd: '/tmp/workspace',
      exitCode: 0
    }
  }

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: () => ({ modelId: 'gpt-5', provider: 'openai.responses' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: (() => ({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 'text-1', text: 'He' }
        yield {
          type: 'tool-input-available',
          toolCallId: 'tool-bash-1',
          toolName: 'bash',
          input: { command: 'pwd' }
        }
        yield {
          type: 'tool-output-available',
          toolCallId: 'tool-bash-1',
          output: {
            content: [{ type: 'text', text: '/tmp/workspace\n' }],
            details: {
              command: 'pwd',
              cwd: '/tmp/workspace',
              stderr: '',
              stdout: '/tmp/workspace\n'
            },
            metadata: {
              cwd: '/tmp/workspace'
            }
          },
          preliminary: true
        }
        yield {
          type: 'tool-output-available',
          toolCallId: 'tool-bash-1',
          output: finalOutput
        }
        yield { type: 'text-delta', id: 'text-1', text: 'llo' }
      })()
    })) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'List the workspace files.' }],
    settings: {
      providerName: 'work',
      provider: 'openai-responses',
      model: 'gpt-5',
      apiKey: 'sk-test',
      baseUrl: ''
    },
    signal: new AbortController().signal,
    onToolCallUpdate: (event) => {
      updates.push({
        output: event.output,
        toolCall: {
          input: event.toolCall.input,
          toolCallId: event.toolCall.toolCallId,
          toolName: event.toolCall.toolName
        }
      })
    },
    onToolCallFinish: (event) => {
      finishes.push({
        success: event.success,
        ...(event.success ? { output: event.output } : {}),
        toolCall: {
          input: event.toolCall.input,
          toolCallId: event.toolCall.toolCallId,
          toolName: event.toolCall.toolName
        }
      })
    }
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['He', 'llo'])
  assert.deepEqual(updates, [
    {
      output: {
        content: [{ type: 'text', text: '/tmp/workspace\n' }],
        details: {
          command: 'pwd',
          cwd: '/tmp/workspace',
          stderr: '',
          stdout: '/tmp/workspace\n'
        },
        metadata: {
          cwd: '/tmp/workspace'
        }
      },
      toolCall: {
        input: { command: 'pwd' },
        toolCallId: 'tool-bash-1',
        toolName: 'bash'
      }
    }
  ])
  assert.deepEqual(finishes, [
    {
      success: true,
      output: finalOutput,
      toolCall: {
        input: { command: 'pwd' },
        toolCallId: 'tool-bash-1',
        toolName: 'bash'
      }
    }
  ])
})

test('createAiSdkModelRuntime can abort the stream after a tool error', async () => {
  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: () => ({ modelId: 'gpt-5', provider: 'openai.responses' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: (() => ({
      fullStream: (async function* () {
        yield {
          type: 'tool-input-available',
          toolCallId: 'tool-send-group-message-1',
          toolName: 'send_group_message',
          input: { message: ': hello there' }
        }
        yield {
          type: 'tool-output-error',
          toolCallId: 'tool-send-group-message-1',
          errorText: 'Rejected: message must not start with a colon.'
        }
        yield { type: 'text-delta', id: 'text-1', text: 'should not continue' }
      })()
    })) as never
  })

  await assert.rejects(
    async () => {
      for await (const chunk of runtime.streamReply({
        messages: [{ role: 'user', content: 'Say hi.' }],
        settings: {
          providerName: 'work',
          provider: 'openai-responses',
          model: 'gpt-5',
          apiKey: 'sk-test',
          baseUrl: ''
        },
        signal: new AbortController().signal,
        onToolCallError: ((event: { toolCall: { toolName: string } }) =>
          event.toolCall.toolName === 'send_group_message' ? 'abort' : 'continue') as never
      } as never)) {
        void chunk
      }
    },
    { message: 'Rejected: message must not start with a colon.' }
  )
})

test('createAiSdkModelRuntime can abort the stream after a tool input error', async () => {
  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: () => ({ modelId: 'gpt-5', provider: 'openai.responses' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: (() => ({
      fullStream: (async function* () {
        yield {
          type: 'tool-input-error',
          toolCallId: 'tool-send-group-message-2',
          toolName: 'send_group_message',
          input: { nope: true },
          errorText: 'Invalid input for tool send_group_message.'
        }
        yield { type: 'text-delta', id: 'text-2', text: 'should not continue' }
      })()
    })) as never
  })

  await assert.rejects(
    async () => {
      for await (const chunk of runtime.streamReply({
        messages: [{ role: 'user', content: 'Say hi.' }],
        settings: {
          providerName: 'work',
          provider: 'openai-responses',
          model: 'gpt-5',
          apiKey: 'sk-test',
          baseUrl: ''
        },
        signal: new AbortController().signal,
        onToolCallError: ((event: { toolCall: { toolName: string } }) =>
          event.toolCall.toolName === 'send_group_message' ? 'abort' : 'continue') as never
      } as never)) {
        void chunk
      }
    },
    { message: 'Invalid input for tool send_group_message.' }
  )
})
test('streamReply forwards tool-output-error after tool-input-error to onToolCallFinish', async () => {
  const finishEvents: Array<{
    success: boolean
    error?: Error
    toolCall: { toolCallId: string; toolName: string }
  }> = []

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: () => ({ modelId: 'gpt-5', provider: 'openai.responses' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: (() => ({
      fullStream: (async function* () {
        yield {
          type: 'tool-input-error',
          toolCallId: 'tc-1',
          toolName: 'send_group_message',
          input: { nope: true },
          errorText: 'Invalid input for tool send_group_message.'
        }
        yield {
          type: 'tool-output-error',
          toolCallId: 'tc-1',
          errorText: 'Invalid input for tool send_group_message.'
        }
        yield { type: 'text-delta', id: 'text-2', text: 'Recovered text' }
      })()
    })) as never
  })

  const chunks: string[] = []
  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Say hi.' }],
    settings: {
      providerName: 'work',
      provider: 'openai-responses',
      model: 'gpt-5',
      apiKey: 'sk-test',
      baseUrl: ''
    },
    signal: new AbortController().signal,
    onToolCallFinish: ((event: {
      success: boolean
      error?: Error
      toolCall: { toolCallId: string; toolName: string }
    }) => {
      finishEvents.push({
        success: event.success,
        error: event.error,
        toolCall: {
          toolCallId: event.toolCall.toolCallId,
          toolName: event.toolCall.toolName
        }
      })
    }) as never
  } as never)) {
    chunks.push(chunk)
  }

  assert.equal(finishEvents.length, 1)
  assert.equal(finishEvents[0]?.success, false)
  assert.equal(finishEvents[0]?.error?.message, 'Invalid input for tool send_group_message.')
  assert.equal(finishEvents[0]?.toolCall.toolCallId, 'tc-1')
  assert.equal(finishEvents[0]?.toolCall.toolName, 'send_group_message')
  assert.deepEqual(chunks, ['Recovered text'])
})

test('createAiSdkModelRuntime uses Google AI provider for gemini', async () => {
  let googleOptions: { apiKey?: string; baseURL?: string } | undefined
  let selectedModel: { provider: string; modelId: string } | null = null

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () => {
      throw new Error('OpenAI should not be used in this test.')
    },
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    createGoogleProvider: (options) => {
      googleOptions = options
      return ((modelId: string) => {
        selectedModel = { modelId, provider: 'google' }
        return { modelId, provider: 'google' } as never
      }) as never
    },
    streamTextImpl: (() => ({
      textStream: (async function* () {
        yield 'Gemini'
      })()
    })) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Hello' }],
    settings: {
      providerName: 'google-ai',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      apiKey: 'AIza_test',
      baseUrl: ''
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['Gemini'])
  assert.deepEqual(googleOptions, {
    apiKey: 'AIza_test',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta'
  })
  assert.deepEqual(selectedModel, { provider: 'google', modelId: 'gemini-2.5-flash' })
})

test('createAiSdkModelRuntime disables Gemini thinking when provider thinking is off', async () => {
  let capturedProviderOptions: Record<string, unknown> | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () => {
      throw new Error('OpenAI should not be used in this test.')
    },
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    createGoogleProvider: () => ((modelId: string) => ({ modelId, provider: 'google' })) as never,
    streamTextImpl: ((input: { providerOptions?: Record<string, unknown> }) => {
      capturedProviderOptions = input.providerOptions
      return {
        textStream: (async function* () {
          yield 'ok'
        })()
      }
    }) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Hello' }],
    settings: {
      providerName: 'google-ai',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      thinkingEnabled: false,
      apiKey: 'AIza_test',
      baseUrl: ''
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['ok'])
  assert.deepEqual(capturedProviderOptions, {
    google: {}
  })
})

test('createAiSdkModelRuntime uses Vertex AI provider for vertex', async () => {
  let vertexOptions: { project?: string; location?: string } | undefined
  let selectedModel: { provider: string; modelId: string } | null = null

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () => {
      throw new Error('OpenAI should not be used in this test.')
    },
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    createVertexProvider: (options?) => {
      vertexOptions = { project: options?.project ?? '', location: options?.location ?? '' }
      return ((modelId: string) => {
        selectedModel = { modelId, provider: 'vertex' }
        return { modelId, provider: 'vertex' } as never
      }) as never
    },
    streamTextImpl: (() => ({
      textStream: (async function* () {
        yield 'VertexAI'
      })()
    })) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Hello' }],
    settings: {
      providerName: 'my-vertex',
      provider: 'vertex',
      model: 'gemini-2.5-flash-001',
      apiKey: '',
      baseUrl: '',
      project: 'my-project',
      location: 'us-central1'
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['VertexAI'])
  assert.deepEqual(vertexOptions, { project: 'my-project', location: 'us-central1' })
  assert.deepEqual(selectedModel, { provider: 'vertex', modelId: 'gemini-2.5-flash-001' })
})

test('createAiSdkModelRuntime caps vertex gemini max_token to the model ceiling', async () => {
  let maxOutputTokens: number | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () => {
      throw new Error('OpenAI should not be used in this test.')
    },
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    createVertexProvider: () => ((modelId: string) => ({ modelId, provider: 'vertex' })) as never,
    streamTextImpl: ((input: { maxOutputTokens?: number }) => {
      maxOutputTokens = input.maxOutputTokens
      return {
        textStream: (async function* () {
          yield 'ok'
        })()
      }
    }) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Limit this reply.' }],
    settings: {
      providerName: 'my-vertex',
      provider: 'vertex',
      model: 'gemini-3.1-pro-preview',
      apiKey: '',
      baseUrl: '',
      project: 'my-project',
      location: 'us-central1'
    },
    signal: new AbortController().signal,
    max_token: 64
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['ok'])
  assert.equal(maxOutputTokens, 65536)
})

test('createAiSdkModelRuntime disables Vertex thinking when provider thinking is off', async () => {
  let capturedProviderOptions: Record<string, unknown> | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () => {
      throw new Error('OpenAI should not be used in this test.')
    },
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    createVertexProvider: () => ((modelId: string) => ({ modelId, provider: 'vertex' })) as never,
    streamTextImpl: ((input: { providerOptions?: Record<string, unknown> }) => {
      capturedProviderOptions = input.providerOptions
      return {
        textStream: (async function* () {
          yield 'ok'
        })()
      }
    }) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Hello' }],
    settings: {
      providerName: 'my-vertex',
      provider: 'vertex',
      model: 'gemini-2.5-flash-001',
      thinkingEnabled: false,
      apiKey: '',
      baseUrl: '',
      project: 'my-project',
      location: 'us-central1'
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['ok'])
  assert.deepEqual(capturedProviderOptions, {
    vertex: {}
  })
})

test('createAiSdkModelRuntime passes gateway vertex routing for google/ models on vercel-gateway', async () => {
  let capturedProviderOptions: Record<string, unknown> | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () => {
      throw new Error('OpenAI should not be used in this test.')
    },
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    createGatewayProvider: () => {
      return ((modelId: string) => ({ modelId, provider: 'gateway' })) as never
    },
    streamTextImpl: ((input: { providerOptions?: Record<string, unknown> }) => {
      capturedProviderOptions = input.providerOptions
      return {
        textStream: (async function* () {
          yield 'ok'
        })()
      }
    }) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Hello' }],
    settings: {
      providerName: 'vercel',
      provider: 'vercel-gateway',
      model: 'google/gemini-2.0-flash',
      apiKey: 'vgw-test',
      baseUrl: ''
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['ok'])
  assert.deepEqual((capturedProviderOptions as { gateway?: { order: string[] } })?.gateway, {
    order: ['vertex']
  })
})

test('createAiSdkModelRuntime disables gateway thinking config when provider thinking is off', async () => {
  let capturedProviderOptions: Record<string, unknown> | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () => {
      throw new Error('OpenAI should not be used in this test.')
    },
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    createGatewayProvider: () => {
      return ((modelId: string) => ({ modelId, provider: 'gateway' })) as never
    },
    streamTextImpl: ((input: { providerOptions?: Record<string, unknown> }) => {
      capturedProviderOptions = input.providerOptions
      return {
        textStream: (async function* () {
          yield 'ok'
        })()
      }
    }) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Hello' }],
    settings: {
      providerName: 'vercel',
      provider: 'vercel-gateway',
      model: 'google/gemini-3-flash',
      thinkingEnabled: false,
      apiKey: 'vgw-test',
      baseUrl: ''
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['ok'])
  assert.deepEqual(capturedProviderOptions, {
    gateway: {
      order: ['vertex']
    }
  })
})

test('createAiSdkModelRuntime skips gateway vertex routing for non-google models on vercel-gateway', async () => {
  let capturedProviderOptions: Record<string, unknown> | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () => {
      throw new Error('OpenAI should not be used in this test.')
    },
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    createGatewayProvider: () => {
      return ((modelId: string) => ({ modelId, provider: 'gateway' })) as never
    },
    streamTextImpl: ((input: { providerOptions?: Record<string, unknown> }) => {
      capturedProviderOptions = input.providerOptions
      return {
        textStream: (async function* () {
          yield 'ok'
        })()
      }
    }) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Hello' }],
    settings: {
      providerName: 'vercel',
      provider: 'vercel-gateway',
      model: 'meta/llama-3-70b',
      apiKey: 'vgw-test',
      baseUrl: ''
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['ok'])
  assert.equal(
    (capturedProviderOptions as { gateway?: unknown } | undefined)?.gateway,
    undefined,
    'non-google model must not receive gateway vertex routing'
  )
})

test('fetchModels allows vertex model fetching via ADC', async () => {
  let requestedUrl = ''
  let authorizationHeader = ''
  let adcCalls = 0

  const models = await fetchModels(
    {
      id: 'provider-vertex',
      name: 'vertex',
      type: 'vertex',
      apiKey: '',
      baseUrl: '',
      project: 'my-project',
      location: 'asia-northeast1',
      modelList: {
        enabled: [],
        disabled: []
      }
    },
    (async (input, init) => {
      requestedUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url

      if (init?.headers instanceof Headers) {
        authorizationHeader = init.headers.get('Authorization') ?? ''
      } else {
        authorizationHeader = String(
          (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
        )
      }

      return new Response(
        JSON.stringify({
          publisherModels: [
            { name: 'publishers/google/models/gemini-2.5-flash-001' },
            { name: 'publishers/google/models/gemini-2.5-pro-001' }
          ]
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }
      )
    }) as typeof globalThis.fetch,
    {
      getVertexAdcAccessToken: async () => {
        adcCalls += 1
        return 'adc-token'
      }
    }
  )

  assert.equal(adcCalls, 1)
  assert.equal(
    requestedUrl,
    'https://asia-northeast1-aiplatform.googleapis.com/v1beta1/publishers/google/models'
  )
  assert.equal(authorizationHeader, 'Bearer adc-token')
  assert.deepEqual(models, ['gemini-2.5-flash-001', 'gemini-2.5-pro-001'])
})

test('fetchModels falls back to us-central1 when vertex location is global', async () => {
  let requestedUrl = ''

  await fetchModels(
    {
      id: 'provider-vertex-global',
      name: 'vertex',
      type: 'vertex',
      apiKey: '',
      baseUrl: '',
      project: 'my-project',
      location: 'global',
      modelList: {
        enabled: [],
        disabled: []
      }
    },
    (async (input) => {
      requestedUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      return new Response(
        JSON.stringify({
          publisherModels: [{ name: 'publishers/google/models/gemini-2.5-flash-001' }]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof globalThis.fetch,
    { getVertexAdcAccessToken: async () => 'adc-token' }
  )

  assert.equal(
    requestedUrl,
    'https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models'
  )
})

// ---------------------------------------------------------------------------
// Retry with exponential backoff
// ---------------------------------------------------------------------------

function createRetryTestRuntime(callResults: Array<{ error?: Error; chunks?: string[] }>): {
  runtime: ReturnType<typeof createAiSdkModelRuntime>
  defaultSettings: {
    providerName: string
    provider: 'openai'
    model: string
    apiKey: string
    baseUrl: string
  }
  getCallCount: () => number
  sleepCalls: number[]
} {
  let callIndex = 0
  const sleepCalls: number[] = []
  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        chat: (modelId: string) => ({ modelId, provider: 'openai.chat' }) as never
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('unused')
    },
    streamTextImpl: (() => {
      const result = callResults[callIndex++]
      if (!result) throw new Error('No more call results configured')
      if (result.error) throw result.error
      return {
        textStream: (async function* () {
          for (const chunk of result.chunks ?? []) yield chunk
        })()
      }
    }) as never,
    sleepImpl: (async (ms: number) => {
      sleepCalls.push(ms)
    }) as never
  })

  const defaultSettings = {
    providerName: 'test',
    provider: 'openai' as const,
    model: 'gpt-4o',
    apiKey: 'sk-test',
    baseUrl: ''
  }

  return { runtime, defaultSettings, getCallCount: () => callIndex, sleepCalls }
}

test('streamReply retries on retryable error and succeeds', async () => {
  const err = new Error('Service Unavailable')
  ;(err as { status?: number }).status = 503
  const { runtime, defaultSettings, getCallCount, sleepCalls } = createRetryTestRuntime([
    { error: err },
    { error: err },
    { chunks: ['Hello'] }
  ])

  const retryEvents: Array<{ attempt: number; maxAttempts: number }> = []
  const chunks: string[] = []
  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'hi' }],
    settings: defaultSettings,
    signal: new AbortController().signal,
    onRetry: (attempt, maxAttempts) => {
      retryEvents.push({ attempt, maxAttempts })
    }
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['Hello'])
  assert.equal(getCallCount(), 3)
  assert.equal(retryEvents.length, 2)
  assert.equal(retryEvents[0].attempt, 1)
  assert.equal(retryEvents[1].attempt, 2)
  assert.equal(retryEvents[0].maxAttempts, 10)
  assert.deepEqual(sleepCalls, [1000, 2000])
})

test('streamReply does not retry on auth error (401)', async () => {
  const err = new Error('Unauthorized')
  ;(err as { status?: number }).status = 401
  const { runtime, defaultSettings, getCallCount, sleepCalls } = createRetryTestRuntime([
    { error: err }
  ])

  await assert.rejects(
    async () => {
      for await (const chunk of runtime.streamReply({
        messages: [{ role: 'user', content: 'hi' }],
        settings: defaultSettings,
        signal: new AbortController().signal
      })) {
        void chunk
      }
    },
    { message: 'Unauthorized' }
  )

  assert.equal(getCallCount(), 1)
  assert.deepEqual(sleepCalls, [])
})

test('streamReply does not retry on user AbortError (aborted signal)', async () => {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  const { runtime, defaultSettings, getCallCount, sleepCalls } = createRetryTestRuntime([
    { error: err }
  ])

  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    async () => {
      for await (const chunk of runtime.streamReply({
        messages: [{ role: 'user', content: 'hi' }],
        settings: defaultSettings,
        signal: controller.signal
      })) {
        void chunk
      }
    },
    { name: 'AbortError' }
  )

  assert.equal(getCallCount(), 1)
  assert.deepEqual(sleepCalls, [])
})

test('streamReply retries on network AbortError', async () => {
  const err = new Error('fetch failed')
  err.name = 'AbortError'
  const { runtime, defaultSettings, getCallCount, sleepCalls } = createRetryTestRuntime([
    { error: err },
    { chunks: ['Hello'] }
  ])

  const chunks: string[] = []
  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'hi' }],
    settings: defaultSettings,
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['Hello'])
  assert.equal(getCallCount(), 2)
  assert.deepEqual(sleepCalls, [1000])
})

test('streamReply passes maxRetries: 0 to AI SDK (disables built-in retries)', async () => {
  let capturedMaxRetries: number | undefined
  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        chat: (modelId: string) => ({ modelId, provider: 'openai.chat' }) as never
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('unused')
    },
    streamTextImpl: ((input: { maxRetries?: number }) => {
      capturedMaxRetries = input.maxRetries
      return {
        textStream: (async function* () {
          yield 'ok'
        })()
      }
    }) as never
  })

  const chunks: string[] = []
  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'hi' }],
    settings: {
      providerName: 'test',
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test',
      baseUrl: ''
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.equal(capturedMaxRetries, 0)
  assert.deepEqual(chunks, ['ok'])
})

function createFullStreamRetryRuntime(
  callResults: Array<{
    error?: Error
    streamEvents?: Array<{ type: string; [key: string]: unknown }>
  }>
): {
  runtime: ReturnType<typeof createAiSdkModelRuntime>
  defaultSettings: {
    providerName: string
    provider: 'openai'
    model: string
    apiKey: string
    baseUrl: string
  }
  getCallCount: () => number
  sleepCalls: number[]
} {
  let callIndex = 0
  const sleepCalls: number[] = []
  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        chat: (modelId: string) => ({ modelId, provider: 'openai.chat' }) as never
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('unused')
    },
    streamTextImpl: (() => {
      const result = callResults[callIndex++]
      if (!result) throw new Error('No more call results configured')
      if (result.error) throw result.error
      return {
        fullStream: (async function* () {
          for (const event of result.streamEvents ?? []) yield event
        })()
      }
    }) as never,
    sleepImpl: (async (ms: number) => {
      sleepCalls.push(ms)
    }) as never
  })

  const defaultSettings = {
    providerName: 'test',
    provider: 'openai' as const,
    model: 'gpt-4o',
    apiKey: 'sk-test',
    baseUrl: ''
  }

  return { runtime, defaultSettings, getCallCount: () => callIndex, sleepCalls }
}

test('streamReply does not retry after tool-input-available has fired (P1: tool side-effects)', async () => {
  const networkErr = new Error('read ECONNRESET')
  ;(networkErr as { code?: string }).code = 'ECONNRESET'

  const { runtime, defaultSettings, getCallCount, sleepCalls } = createFullStreamRetryRuntime([
    {
      streamEvents: [
        { type: 'tool-input-available', toolCallId: 'tc1', toolName: 'bash', input: { cmd: 'ls' } },
        { type: 'error', error: networkErr }
      ]
    }
  ])

  await assert.rejects(
    async () => {
      for await (const chunk of runtime.streamReply({
        messages: [{ role: 'user', content: 'hi' }],
        settings: defaultSettings,
        signal: new AbortController().signal
      })) {
        void chunk
      }
    },
    { message: 'read ECONNRESET' }
  )

  // Must NOT have retried — only 1 call total
  assert.equal(getCallCount(), 1)
  assert.deepEqual(sleepCalls, [])
})

test('streamReply does not retry after tool-input-start has fired (P1: preparing side-effects)', async () => {
  const networkErr = new Error('read ECONNRESET')
  ;(networkErr as { code?: string }).code = 'ECONNRESET'

  const { runtime, defaultSettings, getCallCount, sleepCalls } = createFullStreamRetryRuntime([
    {
      streamEvents: [
        { type: 'tool-input-start', id: 'tc1', toolName: 'bash' },
        { type: 'error', error: networkErr }
      ]
    }
  ])
  const preparingEvents: Array<{ toolCallId: string; toolName: string }> = []

  await assert.rejects(
    async () => {
      for await (const chunk of runtime.streamReply({
        messages: [{ role: 'user', content: 'hi' }],
        settings: defaultSettings,
        signal: new AbortController().signal,
        onToolCallPreparing: (event) => {
          preparingEvents.push(event)
        }
      })) {
        void chunk
      }
    },
    { message: 'read ECONNRESET' }
  )

  assert.deepEqual(preparingEvents, [{ toolCallId: 'tc1', toolName: 'bash' }])
  assert.equal(getCallCount(), 1)
  assert.deepEqual(sleepCalls, [])
})

test('streamReply does not retry after tool-input-error aborts the turn', async () => {
  const { runtime, defaultSettings, getCallCount, sleepCalls } = createFullStreamRetryRuntime([
    {
      streamEvents: [
        {
          type: 'tool-input-error',
          toolCallId: 'tc1',
          toolName: 'send_group_message',
          input: { nope: true },
          errorText: 'Invalid input for tool send_group_message.'
        }
      ]
    }
  ])

  await assert.rejects(
    async () => {
      for await (const chunk of runtime.streamReply({
        messages: [{ role: 'user', content: 'hi' }],
        settings: defaultSettings,
        signal: new AbortController().signal,
        onToolCallError: ((event: { toolCall: { toolName: string } }) =>
          event.toolCall.toolName === 'send_group_message' ? 'abort' : 'continue') as never
      } as never)) {
        void chunk
      }
    },
    { message: 'Invalid input for tool send_group_message.' }
  )

  assert.equal(getCallCount(), 1)
  assert.deepEqual(sleepCalls, [])
})

test('streamReply retries after reasoning deltas when assistant text has not started yet', async () => {
  const networkErr = new Error('socket hang up')

  const { runtime, defaultSettings, getCallCount, sleepCalls } = createFullStreamRetryRuntime([
    {
      streamEvents: [
        { type: 'reasoning-delta', textDelta: 'Let me think...' },
        { type: 'error', error: networkErr }
      ]
    },
    {
      streamEvents: [
        { type: 'reasoning-delta', textDelta: 'Retrying from scratch...' },
        { type: 'text-delta', textDelta: 'Recovered answer' }
      ]
    }
  ])

  const retryEvents: number[] = []
  const reasoningDeltas: string[] = []
  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'hi' }],
    settings: defaultSettings,
    signal: new AbortController().signal,
    onRetry: (attempt) => {
      retryEvents.push(attempt)
    },
    onReasoningDelta: (delta) => {
      reasoningDeltas.push(delta)
    }
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(retryEvents, [1])
  assert.deepEqual(reasoningDeltas, ['Let me think...', 'Retrying from scratch...'])
  assert.deepEqual(chunks, ['Recovered answer'])
  assert.equal(getCallCount(), 2)
  assert.deepEqual(sleepCalls, [1000])
})
