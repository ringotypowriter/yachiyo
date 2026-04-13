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

test('createThinkingFetch injects reasoning_effort for DeepSeek reasoner', async () => {
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

  assert.equal(capturedBody?.reasoning_effort, 'medium')
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

  assert.equal(capturedBody?.reasoning_effort, 'medium')
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
