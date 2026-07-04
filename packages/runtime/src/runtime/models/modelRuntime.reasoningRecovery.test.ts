import assert from 'node:assert/strict'
import test from 'node:test'
import { createAiSdkModelRuntime } from './modelRuntime.ts'

async function withCapturedConsoleInfo<T>(
  fn: () => Promise<T>
): Promise<{ result: T; logs: string[] }> {
  const originalInfo = console.info
  const logs: string[] = []
  console.info = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '))
  }

  try {
    const result = await fn()
    return { result, logs }
  } finally {
    console.info = originalInfo
  }
}

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
      store: false,
      include: ['reasoning.encrypted_content']
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
      store: false,
      include: ['reasoning.encrypted_content']
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

test('createAiSdkModelRuntime surfaces nested fullStream error messages', async () => {
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
          type: 'error',
          error: {
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
            message:
              'Your input exceeds the context window of this model. Please adjust your input and try again.'
          }
        }
      })()
    })) as never
  })

  await assert.rejects(
    async () => {
      for await (const chunk of runtime.streamReply({
        messages: [{ role: 'user', content: 'Summarize this image.' }],
        settings: {
          providerName: 'work',
          provider: 'openai-responses',
          model: 'gpt-5',
          apiKey: 'sk-test',
          baseUrl: ''
        },
        signal: new AbortController().signal
      })) {
        void chunk
      }
    },
    {
      message:
        'Your input exceeds the context window of this model. Please adjust your input and try again.'
    }
  )
})

test('createAiSdkModelRuntime retries context-window errors with stripped context', async () => {
  const calls: unknown[] = []
  const largeOutput = {
    type: 'content',
    value: [{ type: 'text', text: 'x'.repeat(500_000) }]
  }
  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: () => ({ modelId: 'gpt-5', provider: 'openai.responses' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: ((input: { messages: unknown[] }) => {
      calls.push(input.messages)
      if (calls.length === 1) {
        return {
          fullStream: (async function* () {
            yield {
              type: 'error',
              error: {
                type: 'invalid_request_error',
                code: 'context_length_exceeded',
                message:
                  'Your input exceeds the context window of this model. Please adjust your input and try again.'
              }
            }
          })()
        }
      }

      return {
        fullStream: (async function* () {
          yield { type: 'text-delta', id: 'text-1', text: 'ok' }
        })()
      }
    }) as never
  })

  const chunks: string[] = []
  for await (const chunk of runtime.streamReply({
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a1' },
          { type: 'tool-call', toolCallId: 'tc1', toolName: 'read', input: { path: 'old.txt' } }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc1',
            toolName: 'read',
            result: 'ok',
            output: largeOutput
          }
        ]
      },
      { role: 'user', content: 'q2' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a2' },
          { type: 'tool-call', toolCallId: 'tc2', toolName: 'read', input: { path: 'new.txt' } }
        ]
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc2',
            toolName: 'read',
            result: 'ok',
            output: largeOutput
          }
        ]
      },
      { role: 'user', content: 'q3' }
    ] as never,
    settings: {
      providerName: 'work',
      provider: 'openai-responses',
      model: 'gpt-5',
      apiKey: 'sk-test',
      baseUrl: ''
    },
    signal: new AbortController().signal
  })) {
    chunks.push(chunk)
  }

  assert.deepEqual(chunks, ['ok'])
  assert.equal(calls.length, 2)

  const retriedMessages = calls[1] as Array<{ role: string; content: unknown }>
  const oldToolMessage = retriedMessages[3] as { content: Array<{ output: { value: string } }> }
  assert.match(oldToolMessage.content[0].output.value, /\[Stripped: read/)

  const latestToolMessage = retriedMessages[6] as {
    content: Array<{ output: { value: Array<{ text: string }> } }>
  }
  assert.equal(latestToolMessage.content[0].output.value[0].text, 'x'.repeat(500_000))
})

test('createAiSdkModelRuntime does not retry context-window errors when compaction does not shrink the prompt', async () => {
  let callCount = 0
  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: () => ({ modelId: 'gpt-5', provider: 'openai.responses' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: (() => {
      callCount++
      return {
        fullStream: (async function* () {
          yield {
            type: 'error',
            error: {
              code: 'context_length_exceeded',
              message: 'Your input exceeds the context window of this model.'
            }
          }
        })()
      }
    }) as never
  })

  await assert.rejects(
    async () => {
      for await (const chunk of runtime.streamReply({
        messages: [{ role: 'user', content: 'x'.repeat(500_000) }],
        settings: {
          providerName: 'work',
          provider: 'openai-responses',
          model: 'gpt-5',
          apiKey: 'sk-test',
          baseUrl: ''
        },
        signal: new AbortController().signal
      })) {
        void chunk
      }
    },
    { message: 'Your input exceeds the context window of this model.' }
  )

  assert.equal(callCount, 1)
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

test('createAiSdkModelRuntime logs derived step continuation and cache details per step', async () => {
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
        yield { type: 'start-step' }
        yield {
          type: 'finish-step',
          finishReason: 'tool-calls',
          usage: {
            inputTokens: 100,
            outputTokens: 10,
            inputTokenDetails: {
              cacheReadTokens: 64,
              cacheWriteTokens: 8
            }
          }
        }
        yield { type: 'start-step' }
        yield { type: 'text-delta', delta: 'done' }
        yield {
          type: 'finish-step',
          finishReason: 'stop',
          usage: {
            inputTokens: 120,
            outputTokens: 20,
            inputTokenDetails: {
              cacheReadTokens: 80
            }
          }
        }
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: {
            inputTokens: 220,
            outputTokens: 30,
            inputTokenDetails: {
              cacheReadTokens: 144,
              cacheWriteTokens: 8
            }
          }
        }
      })(),
      usage: Promise.resolve({
        inputTokens: 120,
        outputTokens: 20,
        inputTokenDetails: {
          cacheReadTokens: 80
        }
      }),
      totalUsage: Promise.resolve({
        inputTokens: 220,
        outputTokens: 30,
        inputTokenDetails: {
          cacheReadTokens: 144,
          cacheWriteTokens: 8
        }
      }),
      finishReason: Promise.resolve('stop')
    })) as never
  })

  const { result: chunks, logs } = await withCapturedConsoleInfo(async () => {
    const chunks: string[] = []
    for await (const chunk of runtime.streamReply({
      messages: [{ role: 'user', content: 'Use tools.' }],
      settings: {
        providerName: 'work',
        provider: 'openai-responses',
        model: 'gpt-5',
        apiKey: 'sk-test',
        baseUrl: ''
      },
      signal: new AbortController().signal,
      tools: { bash: { description: 'run command' } } as never
    })) {
      chunks.push(chunk)
    }
    return chunks
  })

  assert.deepEqual(chunks, ['done'])
  assert.ok(
    logs.some((line) =>
      line.includes(
        '[yachiyo][llm][unspecified] step 0 finishReason=tool-calls continued=true promptTokens=100 completionTokens=10 cacheRead=64 cacheWrite=8'
      )
    ),
    logs.join('\n')
  )
  assert.ok(
    logs.some((line) =>
      line.includes(
        '[yachiyo][llm][unspecified] step 1 finishReason=stop continued=false promptTokens=120 completionTokens=20 cacheRead=80 cacheWrite=-'
      )
    ),
    logs.join('\n')
  )
  assert.ok(
    logs.some((line) =>
      line.includes(
        '[yachiyo][llm][unspecified] finish finishReason=stop steps=2 totalPromptTokens=220 totalCompletionTokens=30 cacheRead=144 cacheWrite=8'
      )
    ),
    logs.join('\n')
  )
})

test('createAiSdkModelRuntime logs request prefix diagnostics per step', async () => {
  // The per-step body diagnostics are opt-in (O(context) work per step).
  const originalDebugFlag = process.env['YACHIYO_DEBUG_PROMPT_CACHE']
  process.env['YACHIYO_DEBUG_PROMPT_CACHE'] = '1'
  const firstBody = JSON.stringify({
    model: 'gpt-5.5',
    input: [{ role: 'user', content: 'stable prefix' }],
    prompt_cache_key: 'thread-1'
  })
  const secondBody = JSON.stringify({
    model: 'gpt-5.5',
    input: [
      { role: 'user', content: 'stable prefix' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tool-1' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tool-1' }] }
    ],
    prompt_cache_key: 'thread-1'
  })
  const runtime = createAiSdkModelRuntime({
    createOpenAIProvider: () =>
      ({
        responses: () => ({ modelId: 'gpt-5.5', provider: 'openai.responses' })
      }) as never,
    createAnthropicProvider: () => {
      throw new Error('Anthropic should not be used in this test.')
    },
    streamTextImpl: (() => ({
      fullStream: (async function* () {
        yield { type: 'start-step', request: { body: firstBody } }
        yield {
          type: 'finish-step',
          finishReason: 'tool-calls',
          usage: { inputTokens: 100, outputTokens: 10 }
        }
        yield { type: 'start-step', request: { body: secondBody } }
        yield {
          type: 'finish-step',
          finishReason: 'stop',
          usage: {
            inputTokens: 140,
            outputTokens: 20,
            inputTokenDetails: { cacheReadTokens: 80 }
          }
        }
        yield {
          type: 'finish',
          finishReason: 'stop',
          totalUsage: {
            inputTokens: 240,
            outputTokens: 30,
            inputTokenDetails: { cacheReadTokens: 80 }
          }
        }
      })(),
      usage: Promise.resolve({
        inputTokens: 140,
        outputTokens: 20,
        inputTokenDetails: { cacheReadTokens: 80 }
      }),
      totalUsage: Promise.resolve({
        inputTokens: 240,
        outputTokens: 30,
        inputTokenDetails: { cacheReadTokens: 80 }
      }),
      finishReason: Promise.resolve('stop')
    })) as never
  })

  const { logs } = await withCapturedConsoleInfo(async () => {
    for await (const chunk of runtime.streamReply({
      messages: [{ role: 'user', content: 'Use tools.' }],
      settings: {
        providerName: 'openai',
        provider: 'openai-responses',
        model: 'gpt-5.5',
        apiKey: 'sk-test',
        baseUrl: ''
      },
      signal: new AbortController().signal,
      promptCacheKey: 'thread-1',
      tools: { bash: { description: 'run command' } } as never
    })) {
      assert.equal(chunk, '')
    }
  })

  assert.ok(
    logs.some(
      (line) =>
        line.includes('[yachiyo][llm][unspecified] request step 0 bodyChars=') &&
        line.includes('inputItems=1') &&
        line.includes('promptCacheKey=thread-1') &&
        line.includes('commonPrefixInitialChars=-') &&
        line.includes('commonPrefixPreviousChars=-')
    ),
    logs.join('\n')
  )
  assert.ok(
    logs.some(
      (line) =>
        line.includes('[yachiyo][llm][unspecified] request step 1 bodyChars=') &&
        line.includes('inputItems=3') &&
        line.includes('promptCacheKey=thread-1') &&
        /commonPrefixInitialChars=\d+/u.test(line) &&
        /commonPrefixPreviousChars=\d+/u.test(line)
    ),
    logs.join('\n')
  )

  if (originalDebugFlag === undefined) {
    delete process.env['YACHIYO_DEBUG_PROMPT_CACHE']
  } else {
    process.env['YACHIYO_DEBUG_PROMPT_CACHE'] = originalDebugFlag
  }
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
