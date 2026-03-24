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
    openai: { reasoningEffort: 'medium', store: false }
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
    openai: { reasoningEffort: 'medium', store: false }
  })
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
        budgetTokens: 1024
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
