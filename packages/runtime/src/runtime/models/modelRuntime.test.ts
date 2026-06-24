import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createAiSdkModelRuntime } from './modelRuntime.ts'

function encodeBase64Url(input: unknown): string {
  return Buffer.from(JSON.stringify(input)).toString('base64url')
}

function createJwt(exp: number): string {
  return `${encodeBase64Url({ alg: 'none' })}.${encodeBase64Url({ exp })}.signature`
}

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
      reasoningSummary: 'detailed',
      textVerbosity: 'low',
      include: ['reasoning.encrypted_content'],
      store: false
    }
  })
})

test('createAiSdkModelRuntime resolves Codex OAuth auth and sends system text as instructions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yachiyo-runtime-codex-'))
  const authPath = join(root, 'auth.json')
  const accessToken = createJwt(Math.floor(Date.now() / 1000) + 3600)
  let openAiOptions:
    | {
        apiKey?: string
        baseURL?: string
        headers?: Record<string, string>
      }
    | undefined
  let selectedModel: { provider: string; modelId: string } | null = null
  let call:
    | {
        messages: unknown
        providerOptions?: {
          openai?: {
            instructions?: string
            reasoningEffort?: string
            reasoningSummary?: string
            store?: boolean
            textVerbosity?: string
          }
        }
      }
    | undefined

  try {
    await writeFile(
      authPath,
      JSON.stringify(
        {
          tokens: {
            access_token: accessToken,
            refresh_token: 'refresh-token',
            account_id: 'acct_123'
          }
        },
        null,
        2
      ),
      'utf8'
    )

    const runtime = createAiSdkModelRuntime({
      createOpenAIProvider: (options) => {
        openAiOptions = options as typeof openAiOptions
        return {
          chat: () => {
            throw new Error('Codex OAuth must use responses().')
          },
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
        messages: unknown
        providerOptions?: {
          openai?: {
            instructions?: string
            reasoningEffort?: string
            reasoningSummary?: string
            store?: boolean
            textVerbosity?: string
          }
        }
      }) => {
        call = {
          messages: input.messages,
          providerOptions: input.providerOptions
        }
        return {
          textStream: (async function* () {
            yield 'Codex'
          })()
        }
      }) as never
    })

    const chunks: string[] = []
    for await (const chunk of runtime.streamReply({
      messages: [
        { role: 'system', content: 'Use Codex session auth.' },
        { role: 'user', content: 'Say hello' }
      ],
      settings: {
        providerName: 'codex',
        provider: 'openai-codex',
        model: 'gpt-5.1-codex-max',
        apiKey: '',
        baseUrl: '',
        codexSessionPath: authPath
      },
      signal: new AbortController().signal
    })) {
      chunks.push(chunk)
    }

    assert.deepEqual(chunks, ['Codex'])
    assert.equal(openAiOptions?.apiKey, accessToken)
    assert.equal(openAiOptions?.baseURL, 'https://chatgpt.com/backend-api/codex')
    assert.equal(openAiOptions?.headers?.['ChatGPT-Account-ID'], 'acct_123')
    assert.equal(openAiOptions?.headers?.originator, 'codex_cli_rs')
    assert.deepEqual(selectedModel, {
      provider: 'openai.responses',
      modelId: 'gpt-5.1-codex-max'
    })
    assert.deepEqual(call?.messages, [{ role: 'user', content: 'Say hello' }])
    assert.deepEqual(call?.providerOptions, {
      openai: {
        reasoningEffort: 'medium',
        reasoningSummary: 'detailed',
        textVerbosity: 'low',
        include: ['reasoning.encrypted_content'],
        store: false,
        instructions: 'Use Codex session auth.'
      }
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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
      reasoningSummary: 'detailed',
      textVerbosity: 'low',
      include: ['reasoning.encrypted_content'],
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

test('createAiSdkModelRuntime uses responses() for openai-responses auxiliary generation', async () => {
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
        // A dedicated Responses-API provider only speaks /responses; it must serve
        // auxiliary/tool-model calls through responses(), not chat().
        responses: (modelId: string) => {
          selectedModel = { modelId, provider: 'openai.responses' }
          return { modelId, provider: 'openai.responses' }
        },
        chat: () => {
          throw new Error('chat() should not be used for an openai-responses provider.')
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
    provider: 'openai.responses',
    modelId: 'gpt-5-mini'
  })
  assert.deepEqual(providerOptions, {
    openai: {
      textVerbosity: 'low',
      store: false
    }
  })
})

test('createAiSdkModelRuntime keeps chat() for openai reasoning-model auxiliary generation', async () => {
  // The plain `openai` provider only uses the Responses API for reasoning on its main
  // turn; auxiliary/tool-model calls should still drop to the cheaper chat endpoint.
  let selectedModel: { provider: string; modelId: string } | null = null

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: () => {
          throw new Error('responses() should not be used for openai auxiliary generation.')
        },
        chat: (modelId: string) => {
          selectedModel = { modelId, provider: 'openai.chat' }
          return { modelId, provider: 'openai.chat' }
        }
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: (() => ({
      textStream: (async function* () {
        yield 'title'
      })()
    })) as never
  })

  const chunks: string[] = []
  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Plan the MVP' }],
    providerOptionsMode: 'auxiliary',
    settings: {
      providerName: 'work',
      provider: 'openai',
      model: 'gpt-5',
      apiKey: 'sk-test',
      baseUrl: ''
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['title'])
  assert.deepEqual(selectedModel, { provider: 'openai.chat', modelId: 'gpt-5' })
})

test('createAiSdkModelRuntime uses responses() for openai-codex auxiliary generation', async () => {
  // The Codex OAuth backend is a Responses-API backend; auxiliary/tool-model calls
  // must go through responses(), not chat().
  let selectedModel: { provider: string; modelId: string } | null = null

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: (modelId: string) => {
          selectedModel = { modelId, provider: 'openai.responses' }
          return { modelId, provider: 'openai.responses' }
        },
        chat: () => {
          throw new Error('chat() should not be used for an openai-codex provider.')
        }
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: (() => ({
      textStream: (async function* () {
        yield 'title'
      })()
    })) as never
  })

  const chunks: string[] = []
  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Plan the MVP' }],
    providerOptionsMode: 'auxiliary',
    settings: {
      providerName: 'codex',
      provider: 'openai-codex',
      model: 'gpt-5-codex',
      apiKey: '',
      baseUrl: '',
      codexSessionPath: '~/.codex/auth.json'
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['title'])
  assert.deepEqual(selectedModel, { provider: 'openai.responses', modelId: 'gpt-5-codex' })
})
