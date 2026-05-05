import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAiSdkModelRuntime,
  fetchModels,
  injectStepReasoning,
  patchReasoningSignatures
} from './modelRuntime.ts'

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

test('injectStepReasoning sets reasoning_content on first assistant message', () => {
  const responseMessages = [{ role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] }]
  const result = injectStepReasoning(responseMessages, ['Let me think...']) as Array<{
    role: string
    reasoning_content?: string
  }>

  assert.equal(result.length, 1)
  assert.equal(result[0].reasoning_content, 'Let me think...')
})

test('injectStepReasoning maps per-step reasoning_content to corresponding assistant messages', () => {
  const responseMessages = [
    { role: 'assistant', content: [{ type: 'tool-call', toolName: 'bash', toolCallId: 'tc1' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
  ]
  const result = injectStepReasoning(responseMessages, [
    'Step 1 thinking',
    'Step 2 thinking'
  ]) as Array<{
    role: string
    reasoning_content?: string
  }>

  assert.equal(result.length, 3)
  assert.equal(result[0].reasoning_content, 'Step 1 thinking')
  assert.equal(result[1].role, 'tool')
  assert.equal(result[2].reasoning_content, 'Step 2 thinking')
})

test('injectStepReasoning skips when reasoning_content already exists', () => {
  const responseMessages = [
    {
      role: 'assistant',
      reasoning_content: 'Already here',
      content: [{ type: 'text', text: 'Hello!' }]
    }
  ]
  const result = injectStepReasoning(responseMessages, ['New reasoning'])

  assert.equal(result, responseMessages, 'should return the same reference unchanged')
})

test('injectStepReasoning returns unchanged when perStepReasoning is all empty', () => {
  const responseMessages = [{ role: 'assistant', content: [{ type: 'text', text: 'Hi' }] }]
  const result = injectStepReasoning(responseMessages, ['', ''])

  assert.equal(result, responseMessages)
})

test('injectStepReasoning preserves step alignment with empty entries', () => {
  const responseMessages = [
    { role: 'assistant', content: [{ type: 'tool-call', toolName: 'bash', toolCallId: 'tc1' }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc1' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
  ]
  const result = injectStepReasoning(responseMessages, ['', 'Only step 2 thinking']) as Array<{
    role: string
    reasoning_content?: string
  }>

  assert.equal(result[0].reasoning_content, undefined, 'first assistant has no reasoning')
  assert.equal(result[2].reasoning_content, 'Only step 2 thinking')
})

test('streamReply injects reasoning_content into responseMessages for OpenAI-compatible provider', async () => {
  let finishedUsage:
    | {
        responseMessages?: unknown[]
      }
    | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        chat: (modelId: string) => ({ modelId, provider: 'openai.chat' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('unused')
    },
    streamTextImpl: (() => ({
      fullStream: (async function* () {
        yield { type: 'reasoning-delta', delta: 'Thinking step 1... ' }
        yield { type: 'reasoning-delta', delta: 'done.' }
        yield {
          type: 'tool-input-start',
          id: 'tc1',
          toolName: 'bash'
        }
        yield {
          type: 'tool-input-available',
          toolCallId: 'tc1',
          toolName: 'bash',
          input: { command: 'ls' }
        }
        yield {
          type: 'tool-output-available',
          toolCallId: 'tc1',
          toolName: 'bash',
          output: { stdout: 'file.txt' }
        }
        yield { type: 'finish-step', finishReason: 'tool-calls', stepNumber: 0 }
        yield { type: 'reasoning-delta', delta: 'Step 2 reasoning' }
        yield { type: 'text-delta', delta: 'Here are the files.' }
        yield { type: 'finish-step', finishReason: 'stop', stepNumber: 1 }
      })(),
      usage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
      totalUsage: Promise.resolve({ inputTokens: 200, outputTokens: 100 }),
      finishReason: Promise.resolve('stop'),
      response: Promise.resolve({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'tc1', toolName: 'bash', args: { command: 'ls' } }
            ]
          },
          {
            role: 'tool',
            content: [{ type: 'tool-result', toolCallId: 'tc1', result: { stdout: 'file.txt' } }]
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Here are the files.' }]
          }
        ]
      })
    })) as never
  })

  const reasoningDeltas: string[] = []
  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'List files.' }],
    settings: {
      providerName: 'deepseek',
      provider: 'openai',
      model: 'deepseek-v4',
      apiKey: 'sk-test',
      baseUrl: 'https://api.deepseek.com/v1'
    },
    signal: new AbortController().signal,
    tools: { bash: { description: 'run command' } } as never,
    onReasoningDelta: (delta) => {
      reasoningDeltas.push(delta)
    },
    onFinish: (usage) => {
      finishedUsage = usage
    }
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(reasoningDeltas, ['Thinking step 1... ', 'done.', 'Step 2 reasoning'])
  assert.deepEqual(chunks, ['Here are the files.'])

  const responseMessages = finishedUsage?.responseMessages as Array<{
    role: string
    reasoning_content?: string
    content: Array<{ type: string }>
  }>
  assert.ok(responseMessages, 'responseMessages should be set')
  assert.equal(responseMessages.length, 3)

  assert.equal(responseMessages[0].role, 'assistant')
  assert.equal(responseMessages[0].reasoning_content, 'Thinking step 1... done.')
  assert.equal(responseMessages[0].content[0].type, 'tool-call')

  assert.equal(responseMessages[1].role, 'tool')
  assert.equal((responseMessages[1] as { reasoning_content?: string }).reasoning_content, undefined)

  assert.equal(responseMessages[2].role, 'assistant')
  assert.equal(responseMessages[2].reasoning_content, 'Step 2 reasoning')
  assert.equal(responseMessages[2].content[0].type, 'text')
})

test('streamReply does not double-inject reasoning_content when it already exists', async () => {
  let finishedUsage:
    | {
        responseMessages?: unknown[]
      }
    | undefined

  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        chat: (modelId: string) => ({ modelId, provider: 'openai.chat' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('unused')
    },
    streamTextImpl: (() => ({
      fullStream: (async function* () {
        yield { type: 'reasoning-delta', delta: 'Thinking' }
        yield { type: 'text-delta', delta: 'Answer' }
      })(),
      usage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
      totalUsage: Promise.resolve({ inputTokens: 100, outputTokens: 50 }),
      finishReason: Promise.resolve('stop'),
      response: Promise.resolve({
        messages: [
          {
            role: 'assistant',
            reasoning_content: 'Already captured',
            content: [{ type: 'text', text: 'Answer' }]
          }
        ]
      })
    })) as never
  })

  const chunks: string[] = []

  for await (const chunk of runtime.streamReply({
    messages: [{ role: 'user', content: 'Think.' }],
    settings: {
      providerName: 'test',
      provider: 'openai',
      model: 'test-model',
      apiKey: 'sk-test',
      baseUrl: 'https://example.com'
    },
    signal: new AbortController().signal,
    onReasoningDelta: () => {},
    onFinish: (usage) => {
      finishedUsage = usage
    }
  })) {
    chunks.push(chunk)
  }

  const responseMessages = finishedUsage?.responseMessages as Array<{
    role: string
    reasoning_content?: string
  }>
  assert.ok(responseMessages)
  assert.equal(responseMessages[0].reasoning_content, 'Already captured')
})

test('patchReasoningSignatures strips synthetic anthropic signatures for openai provider', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Thinking...',
          providerOptions: { anthropic: { signature: 'yachiyo-passthrough' } }
        }
      ]
    }
  ]

  const result = patchReasoningSignatures(messages, 'openai')

  assert.deepEqual(result, [
    {
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'Thinking...' }]
    }
  ])
})

test('patchReasoningSignatures drops non-openai reasoning parts for openai-responses provider', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Thinking...',
          providerMetadata: { anthropic: { signature: 'yachiyo-passthrough' } }
        }
      ]
    }
  ]

  const result = patchReasoningSignatures(messages, 'openai-responses')

  assert.deepEqual(result, [
    {
      role: 'assistant',
      content: []
    }
  ])
})

test('patchReasoningSignatures preserves real anthropic signatures for non-anthropic providers', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Thinking...',
          providerOptions: { anthropic: { signature: 'real-signature' } }
        }
      ]
    }
  ]

  const result = patchReasoningSignatures(messages, 'openai')

  assert.deepEqual(result, messages)
})

test('patchReasoningSignatures injects synthetic signature for anthropic provider', () => {
  const messages = [
    {
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'Thinking...' }]
    }
  ]

  const result = patchReasoningSignatures(messages, 'anthropic')

  assert.deepEqual(result, [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Thinking...',
          providerOptions: { anthropic: { signature: 'yachiyo-passthrough' } },
          providerMetadata: { anthropic: { signature: 'yachiyo-passthrough' } }
        }
      ]
    }
  ])
})

test('patchReasoningSignatures does not synthesize anthropic signature for OpenAI reasoning metadata', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'OpenAI reasoning',
          providerOptions: {
            openai: { itemId: 'rs_123', reasoningEncryptedContent: 'enc' }
          }
        }
      ]
    }
  ]

  const result = patchReasoningSignatures(messages, 'anthropic')

  assert.deepEqual(result, messages)
})

test('patchReasoningSignatures preserves openai metadata for non-anthropic providers', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Thinking...',
          providerOptions: {
            openai: { itemId: 'rs_123', reasoningEncryptedContent: 'enc' }
          }
        }
      ]
    }
  ]

  const result = patchReasoningSignatures(messages, 'openai-responses')

  assert.deepEqual(result, messages)
})

test('patchReasoningSignatures copies OpenAI metadata to providerOptions for openai-responses provider', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'OpenAI reasoning',
          providerMetadata: {
            openai: { itemId: 'rs_123', reasoningEncryptedContent: 'enc' }
          }
        }
      ]
    }
  ]

  const result = patchReasoningSignatures(messages, 'openai-responses')

  assert.deepEqual(result, [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'OpenAI reasoning',
          providerOptions: {
            openai: { itemId: 'rs_123', reasoningEncryptedContent: 'enc' }
          },
          providerMetadata: {
            openai: { itemId: 'rs_123', reasoningEncryptedContent: 'enc' }
          }
        }
      ]
    }
  ])
})

test('patchReasoningSignatures copies anthropic metadata to providerOptions for anthropic provider', () => {
  const messages = [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Thinking...',
          providerMetadata: { anthropic: { signature: 'real-sig' } }
        }
      ]
    }
  ]

  const result = patchReasoningSignatures(messages, 'anthropic')

  assert.deepEqual(result, [
    {
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Thinking...',
          providerOptions: { anthropic: { signature: 'real-sig' } },
          providerMetadata: { anthropic: { signature: 'real-sig' } }
        }
      ]
    }
  ])
})
