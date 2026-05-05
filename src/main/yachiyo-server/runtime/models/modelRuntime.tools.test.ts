import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiSdkModelRuntime } from './modelRuntime.ts'

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
