import assert from 'node:assert/strict'
import test from 'node:test'

import type { ProviderSettings } from '../../../../shared/yachiyo/protocol'
import { createThinkingFetch, isOpenAiCompatibleThinkingHost } from './openaiCompatibleThinking.ts'

function makeSettings(overrides: Partial<ProviderSettings> = {}): ProviderSettings {
  return {
    providerName: 'test',
    provider: 'openai',
    model: 'deepseek-reasoner',
    apiKey: 'sk-test',
    baseUrl: 'https://api.deepseek.com/v1',
    ...overrides
  }
}

// ---------------------------------------------------------------------------
// isOpenAiCompatibleThinkingHost
// ---------------------------------------------------------------------------

test('isOpenAiCompatibleThinkingHost recognises DeepSeek', () => {
  assert.equal(isOpenAiCompatibleThinkingHost('https://api.deepseek.com/v1'), true)
})

test('isOpenAiCompatibleThinkingHost recognises DashScope', () => {
  assert.equal(
    isOpenAiCompatibleThinkingHost('https://dashscope.aliyuncs.com/compatible-mode/v1'),
    true
  )
})

test('isOpenAiCompatibleThinkingHost recognises Moonshot', () => {
  assert.equal(isOpenAiCompatibleThinkingHost('https://api.moonshot.cn/v1'), true)
})

test('isOpenAiCompatibleThinkingHost recognises SiliconFlow', () => {
  assert.equal(isOpenAiCompatibleThinkingHost('https://api.siliconflow.cn/v1'), true)
})

test('isOpenAiCompatibleThinkingHost recognises OpenRouter', () => {
  assert.equal(isOpenAiCompatibleThinkingHost('https://openrouter.ai/api/v1'), true)
})

test('isOpenAiCompatibleThinkingHost recognises Zhipu GLM', () => {
  assert.equal(isOpenAiCompatibleThinkingHost('https://open.bigmodel.cn/api/paas/v4'), true)
})

test('isOpenAiCompatibleThinkingHost recognises MiniMax', () => {
  assert.equal(isOpenAiCompatibleThinkingHost('https://api.minimaxi.com/v1'), true)
})

test('isOpenAiCompatibleThinkingHost rejects official OpenAI', () => {
  assert.equal(isOpenAiCompatibleThinkingHost('https://api.openai.com/v1'), false)
})

test('isOpenAiCompatibleThinkingHost rejects invalid URL', () => {
  assert.equal(isOpenAiCompatibleThinkingHost('not-a-url'), false)
})

// ---------------------------------------------------------------------------
// createThinkingFetch — DeepSeek
// ---------------------------------------------------------------------------

test('createThinkingFetch injects thinking object for DeepSeek reasoner', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response('{}')
  }

  const settings = makeSettings({
    model: 'deepseek-reasoner',
    baseUrl: 'https://api.deepseek.com/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch)
  assert.ok(wrappedFetch)

  await wrappedFetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek-reasoner', messages: [] })
  })

  assert.deepEqual(capturedBody?.thinking, { type: 'enabled' })
})

test('createThinkingFetch injects thinking object for DeepSeek V3', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response('{}')
  }

  const settings = makeSettings({
    model: 'deepseek-v3',
    baseUrl: 'https://api.deepseek.com/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch)
  assert.ok(wrappedFetch)

  await wrappedFetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek-v3', messages: [] })
  })

  assert.deepEqual(capturedBody?.thinking, { type: 'enabled' })
})

test('createThinkingFetch injects thinking object for DeepSeek V4', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response('{}')
  }

  const settings = makeSettings({
    model: 'deepseek-v4',
    baseUrl: 'https://api.deepseek.com/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch)
  assert.ok(wrappedFetch)

  await wrappedFetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek-v4', messages: [] })
  })

  assert.deepEqual(capturedBody?.thinking, { type: 'enabled' })
})

test('createThinkingFetch skips DeepSeek non-reasoner models', () => {
  const settings = makeSettings({ model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' })
  const wrappedFetch = createThinkingFetch(settings, 'default')
  assert.equal(wrappedFetch, undefined)
})

// ---------------------------------------------------------------------------
// createThinkingFetch — DashScope (Qwen, GLM, MiniMax)
// ---------------------------------------------------------------------------

test('createThinkingFetch injects enable_thinking for Qwen3 on DashScope', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response('{}')
  }

  const settings = makeSettings({
    model: 'qwen3-235b-a22b',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch)
  assert.ok(wrappedFetch)

  await wrappedFetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'qwen3-235b-a22b', messages: [] })
  })

  assert.equal(capturedBody?.enable_thinking, true)
  assert.equal(capturedBody?.thinking_budget, 4096)
})

test('createThinkingFetch injects enable_thinking for GLM on DashScope', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response('{}')
  }

  const settings = makeSettings({
    model: 'glm-4.7',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch)
  assert.ok(wrappedFetch)

  await wrappedFetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'glm-4.7', messages: [] })
  })

  assert.equal(capturedBody?.enable_thinking, true)
  assert.equal(capturedBody?.thinking_budget, 4096)
})

test('createThinkingFetch skips MiniMax on DashScope (always-on thinking)', () => {
  const settings = makeSettings({
    model: 'MiniMax/MiniMax-M2.7',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default')
  assert.equal(wrappedFetch, undefined)
})

// ---------------------------------------------------------------------------
// createThinkingFetch — Zhipu GLM (own endpoint)
// ---------------------------------------------------------------------------

test('createThinkingFetch injects enable_thinking for Zhipu GLM own endpoint', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response('{}')
  }

  const settings = makeSettings({
    model: 'glm-4-plus',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch)
  assert.ok(wrappedFetch)

  await wrappedFetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'glm-4-plus', messages: [] })
  })

  assert.equal(capturedBody?.enable_thinking, true)
  assert.equal(capturedBody?.thinking_budget, 4096)
})

// ---------------------------------------------------------------------------
// createThinkingFetch — MiniMax (own endpoint, always-on)
// ---------------------------------------------------------------------------

test('createThinkingFetch skips MiniMax own endpoint (always-on thinking)', () => {
  const settings = makeSettings({
    model: 'MiniMax-M2.7',
    baseUrl: 'https://api.minimaxi.com/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default')
  assert.equal(wrappedFetch, undefined)
})

// ---------------------------------------------------------------------------
// createThinkingFetch — Kimi / Moonshot
// ---------------------------------------------------------------------------

test('createThinkingFetch injects thinking object for Kimi k2', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response('{}')
  }

  const settings = makeSettings({
    model: 'kimi-k2-0711-preview',
    baseUrl: 'https://api.moonshot.cn/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch)
  assert.ok(wrappedFetch)

  await wrappedFetch('https://api.moonshot.cn/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'kimi-k2-0711-preview', messages: [] })
  })

  assert.deepEqual(capturedBody?.thinking, { type: 'enabled', budget_tokens: 8192 })
})

test('createThinkingFetch skips non-k2 Moonshot models', () => {
  const settings = makeSettings({
    model: 'moonshot-v1-8k',
    baseUrl: 'https://api.moonshot.cn/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default')
  assert.equal(wrappedFetch, undefined)
})

test('createThinkingFetch injects disable override for Kimi k2 when thinking is off', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response('{}')
  }

  const settings = makeSettings({
    model: 'kimi-k2-0711-preview',
    baseUrl: 'https://api.moonshot.cn/v1',
    thinkingEnabled: false
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch)
  assert.ok(wrappedFetch, 'should create wrapper to inject disable params')

  await wrappedFetch('https://api.moonshot.cn/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'kimi-k2-0711-preview', messages: [] })
  })

  assert.deepEqual(capturedBody?.thinking, { type: 'disabled' })
})

test('createThinkingFetch skips disable override for non-k2 Moonshot models', () => {
  const settings = makeSettings({
    model: 'moonshot-v1-8k',
    baseUrl: 'https://api.moonshot.cn/v1',
    thinkingEnabled: false
  })
  const wrappedFetch = createThinkingFetch(settings, 'default')
  assert.equal(wrappedFetch, undefined)
})

// ---------------------------------------------------------------------------
// createThinkingFetch — OpenRouter
// ---------------------------------------------------------------------------

test('createThinkingFetch injects reasoning object for OpenRouter', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response('{}')
  }

  const settings = makeSettings({
    model: 'deepseek/deepseek-r1',
    baseUrl: 'https://openrouter.ai/api/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch)
  assert.ok(wrappedFetch)

  await wrappedFetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek/deepseek-r1', messages: [] })
  })

  assert.deepEqual(capturedBody?.reasoning, { effort: 'medium' })
})

// ---------------------------------------------------------------------------
// createThinkingFetch — SiliconFlow (pass-through)
// ---------------------------------------------------------------------------

test('createThinkingFetch uses DeepSeek params for SiliconFlow DeepSeek model', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response('{}')
  }

  const settings = makeSettings({
    model: 'deepseek-ai/DeepSeek-R1',
    baseUrl: 'https://api.siliconflow.cn/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch)
  assert.ok(wrappedFetch)

  await wrappedFetch('https://api.siliconflow.cn/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek-ai/DeepSeek-R1', messages: [] })
  })

  assert.deepEqual(capturedBody?.thinking, { type: 'enabled' })
})

test('createThinkingFetch uses DeepSeek V3 params for SiliconFlow DeepSeek model', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response('{}')
  }

  const settings = makeSettings({
    model: 'deepseek-ai/DeepSeek-V3',
    baseUrl: 'https://api.siliconflow.cn/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch)
  assert.ok(wrappedFetch)

  await wrappedFetch('https://api.siliconflow.cn/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek-ai/DeepSeek-V3', messages: [] })
  })

  assert.deepEqual(capturedBody?.thinking, { type: 'enabled' })
})

test('createThinkingFetch uses Qwen params for SiliconFlow QwQ model', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response('{}')
  }

  const settings = makeSettings({
    model: 'Qwen/QwQ-32B',
    baseUrl: 'https://api.siliconflow.cn/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch)
  assert.ok(wrappedFetch)

  await wrappedFetch('https://api.siliconflow.cn/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'Qwen/QwQ-32B', messages: [] })
  })

  assert.equal(capturedBody?.enable_thinking, true)
  assert.equal(capturedBody?.thinking_budget, 4096)
})

// ---------------------------------------------------------------------------
// createThinkingFetch — OpenCode Go
// ---------------------------------------------------------------------------

test('isOpenAiCompatibleThinkingHost recognises OpenCode Go', () => {
  assert.equal(isOpenAiCompatibleThinkingHost('https://opencode.ai/zen/go/v1'), true)
})

test('createThinkingFetch injects enable_thinking for OpenCode Go GLM model', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response('{}')
  }

  const settings = makeSettings({
    model: 'glm-5.1',
    baseUrl: 'https://opencode.ai/zen/go/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch)
  assert.ok(wrappedFetch)

  await wrappedFetch('https://opencode.ai/zen/go/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'glm-5.1', messages: [] })
  })

  assert.equal(capturedBody?.enable_thinking, true)
  assert.equal(capturedBody?.thinking_budget, 4096)
})

test('createThinkingFetch injects thinking object for OpenCode Go Kimi K2 model', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response('{}')
  }

  const settings = makeSettings({
    model: 'kimi-k2.5',
    baseUrl: 'https://opencode.ai/zen/go/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch)
  assert.ok(wrappedFetch)

  await wrappedFetch('https://opencode.ai/zen/go/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'kimi-k2.5', messages: [] })
  })

  assert.deepEqual(capturedBody?.thinking, { type: 'enabled', budget_tokens: 8192 })
})

test('createThinkingFetch injects thinking object for OpenCode Go DeepSeek model', async () => {
  let capturedBody: Record<string, unknown> | undefined
  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(init?.body as string)
    return new Response('{}')
  }

  const settings = makeSettings({
    model: 'deepseek-v4-pro',
    baseUrl: 'https://opencode.ai/zen/go/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch)
  assert.ok(wrappedFetch)

  await wrappedFetch('https://opencode.ai/zen/go/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [] })
  })

  assert.deepEqual(capturedBody?.thinking, { type: 'enabled' })
})

test('createThinkingFetch skips OpenCode Go unknown models', () => {
  const settings = makeSettings({
    model: 'some-unknown-model',
    baseUrl: 'https://opencode.ai/zen/go/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default')
  assert.equal(wrappedFetch, undefined)
})

// ---------------------------------------------------------------------------
// Guards: thinkingEnabled, mode
// ---------------------------------------------------------------------------

test('createThinkingFetch returns undefined when thinkingEnabled is false', () => {
  const settings = makeSettings({ thinkingEnabled: false })
  assert.equal(createThinkingFetch(settings, 'default'), undefined)
})

test('createThinkingFetch returns undefined for auxiliary mode', () => {
  const settings = makeSettings()
  assert.equal(createThinkingFetch(settings, 'auxiliary'), undefined)
})

test('createThinkingFetch returns undefined for unknown host', () => {
  const settings = makeSettings({ baseUrl: 'https://api.openai.com/v1' })
  assert.equal(createThinkingFetch(settings, 'default'), undefined)
})

// ---------------------------------------------------------------------------
// SSE response stream — reasoning_content extraction
// ---------------------------------------------------------------------------

test('createThinkingFetch extracts reasoning_content from SSE response', async () => {
  const reasoningDeltas: string[] = []

  const sseBody = [
    'data: {"choices":[{"delta":{"reasoning_content":"Let me "}}]}\n\n',
    'data: {"choices":[{"delta":{"reasoning_content":"think..."}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hello!"}}]}\n\n',
    'data: [DONE]\n\n'
  ].join('')

  const fakeFetch: typeof globalThis.fetch = async () => {
    return new Response(sseBody, {
      headers: { 'content-type': 'text/event-stream' }
    })
  }

  const settings = makeSettings({
    model: 'deepseek-reasoner',
    baseUrl: 'https://api.deepseek.com/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch, {
    onReasoningDelta: (delta) => reasoningDeltas.push(delta)
  })
  assert.ok(wrappedFetch)

  const response = await wrappedFetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({ model: 'deepseek-reasoner', messages: [] })
  })

  // Consume the full body to trigger the transform
  await response.text()

  assert.deepEqual(reasoningDeltas, ['Let me ', 'think...'])
})

test('createThinkingFetch extracts reasoning_content for MiniMax on DashScope (always-on)', async () => {
  const reasoningDeltas: string[] = []

  const sseBody = [
    'data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n',
    'data: [DONE]\n\n'
  ].join('')

  const fakeFetch: typeof globalThis.fetch = async () => {
    return new Response(sseBody, {
      headers: { 'content-type': 'text/event-stream' }
    })
  }

  const settings = makeSettings({
    model: 'MiniMax/MiniMax-M2.7',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  })
  // MiniMax has no extra params but we provide onReasoningDelta
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch, {
    onReasoningDelta: (delta) => reasoningDeltas.push(delta)
  })
  assert.ok(wrappedFetch)

  const response = await wrappedFetch(
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    {
      method: 'POST',
      body: JSON.stringify({ model: 'MiniMax/MiniMax-M2.7', messages: [] })
    }
  )

  await response.text()
  assert.deepEqual(reasoningDeltas, ['Thinking...'])
})

// ---------------------------------------------------------------------------
// Multi-step tool call: reasoning_content echo-back
// ---------------------------------------------------------------------------

test('createThinkingFetch echoes reasoning_content back in subsequent requests', async () => {
  let callCount = 0
  const capturedBodies: Array<Record<string, unknown>> = []

  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBodies.push(JSON.parse(init?.body as string))
    callCount++

    if (callCount === 1) {
      const sseBody = [
        'data: {"choices":[{"delta":{"reasoning_content":"I should use bash"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":null,"tool_calls":[{"index":0,"id":"tc1","type":"function","function":{"name":"bash","arguments":"{\\"cmd\\":\\"ls\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n'
      ].join('')
      return new Response(sseBody, {
        headers: { 'content-type': 'text/event-stream' }
      })
    }

    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Here are the files."}}]}\n\n',
      'data: [DONE]\n\n'
    ].join('')
    return new Response(sseBody, {
      headers: { 'content-type': 'text/event-stream' }
    })
  }

  const settings = makeSettings({
    model: 'deepseek-reasoner',
    baseUrl: 'https://api.deepseek.com/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch, {
    onReasoningDelta: () => {}
  })
  assert.ok(wrappedFetch)

  // First call: model reasons then calls a tool
  const response1 = await wrappedFetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'List files' }]
    })
  })
  await response1.text()

  // Second call: SDK sends tool result — should have reasoning_content echoed back
  const response2 = await wrappedFetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'deepseek-reasoner',
      messages: [
        { role: 'user', content: 'List files' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'tc1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }
          ]
        },
        { role: 'tool', tool_call_id: 'tc1', content: 'file.txt' }
      ]
    })
  })
  await response2.text()

  assert.equal(capturedBodies.length, 2)

  // The second request's assistant message should have reasoning_content injected
  const secondMessages = capturedBodies[1].messages as Array<Record<string, unknown>>
  const assistantMsg = secondMessages.find((m) => m.role === 'assistant')
  assert.ok(assistantMsg, 'assistant message should exist in second request')
  assert.equal(assistantMsg.reasoning_content, 'I should use bash')
})

test('createThinkingFetch echoes empty reasoning_content to preserve field presence', async () => {
  let callCount = 0
  const capturedBodies: Array<Record<string, unknown>> = []

  const fakeFetch: typeof globalThis.fetch = async (_input, init) => {
    capturedBodies.push(JSON.parse(init?.body as string))
    callCount++

    if (callCount === 1) {
      // Step 1: reasoning + tool call
      const sseBody = [
        'data: {"choices":[{"delta":{"reasoning_content":"Think first"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc1","type":"function","function":{"name":"read","arguments":"{}"}}]}}]}\n\n',
        'data: [DONE]\n\n'
      ].join('')
      return new Response(sseBody, { headers: { 'content-type': 'text/event-stream' } })
    }

    if (callCount === 2) {
      // Step 2: NO reasoning, just another tool call
      const sseBody = [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc2","type":"function","function":{"name":"write","arguments":"{}"}}]}}]}\n\n',
        'data: [DONE]\n\n'
      ].join('')
      return new Response(sseBody, { headers: { 'content-type': 'text/event-stream' } })
    }

    // Step 3: final response
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Done"}}]}\n\n',
      'data: [DONE]\n\n'
    ].join('')
    return new Response(sseBody, { headers: { 'content-type': 'text/event-stream' } })
  }

  const settings = makeSettings({
    model: 'deepseek-reasoner',
    baseUrl: 'https://api.deepseek.com/v1'
  })
  const wrappedFetch = createThinkingFetch(settings, 'default', fakeFetch, {
    onReasoningDelta: () => {}
  })
  assert.ok(wrappedFetch)

  // Step 1
  const r1 = await wrappedFetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'go' }]
    })
  })
  await r1.text()

  // Step 2: 1 assistant message
  const r2 = await wrappedFetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'deepseek-reasoner',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'tc1' }] },
        { role: 'tool', tool_call_id: 'tc1', content: 'result1' }
      ]
    })
  })
  await r2.text()

  // Step 3: 2 assistant messages — first should have reasoning, second should have empty field
  const r3 = await wrappedFetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: 'deepseek-reasoner',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'tc1' }] },
        { role: 'tool', tool_call_id: 'tc1', content: 'result1' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'tc2' }] },
        { role: 'tool', tool_call_id: 'tc2', content: 'result2' }
      ]
    })
  })
  await r3.text()

  assert.equal(capturedBodies.length, 3)

  // Step 3 request should have both assistant messages with reasoning_content
  const thirdMessages = capturedBodies[2].messages as Array<Record<string, unknown>>
  const assistantMsgs = thirdMessages.filter((m) => m.role === 'assistant')
  assert.equal(assistantMsgs.length, 2)
  assert.equal(assistantMsgs[0].reasoning_content, 'Think first')
  assert.equal(
    assistantMsgs[1].reasoning_content,
    '',
    'empty reasoning must still be present as field'
  )
})
