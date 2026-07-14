import assert from 'node:assert/strict'
import test from 'node:test'

import { createAuxiliaryGenerationService } from './auxiliaryGeneration.ts'
import type { ModelStreamRequest } from './types.ts'

test('generateText forwards max_token to model runtime requests', async () => {
  let capturedMaxToken: number | undefined

  const service = createAuxiliaryGenerationService({
    createModelRuntime: () => ({
      async *streamReply(request: ModelStreamRequest): AsyncIterable<string> {
        capturedMaxToken = request.max_token
        yield 'ok'
      }
    }),
    readToolModelSettings: () => ({
      providerName: 'tool-model',
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test',
      baseUrl: ''
    })
  })

  const result = await service.generateText({
    messages: [{ role: 'user', content: 'hello' }],
    max_token: 128
  })

  assert.equal(result.status, 'success')
  assert.equal(result.text, 'ok')
  assert.equal(capturedMaxToken, 128)
})

test('generateText forwards onToolCallError to the model runtime request', async () => {
  let capturedOnToolCallError: unknown

  const service = createAuxiliaryGenerationService({
    createModelRuntime: () => ({
      async *streamReply(request: ModelStreamRequest): AsyncIterable<string> {
        capturedOnToolCallError = (request as ModelStreamRequest & { onToolCallError?: unknown })
          .onToolCallError
        yield 'ok'
      }
    }),
    readToolModelSettings: () => ({
      providerName: 'tool-model',
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test',
      baseUrl: ''
    })
  })

  const onToolCallError = (): 'abort' => 'abort'
  const result = await service.generateText({
    messages: [{ role: 'user', content: 'hello' }],
    onToolCallError: onToolCallError as never
  } as never)

  assert.equal(result.status, 'success')
  assert.equal(capturedOnToolCallError, onToolCallError)
})

test('generateText exposes the first provider-reported prompt count', async () => {
  const service = createAuxiliaryGenerationService({
    createModelRuntime: () => ({
      async *streamReply(request: ModelStreamRequest): AsyncIterable<string> {
        request.onStepUsage?.({ promptTokens: 321, completionTokens: 10 })
        request.onStepUsage?.({ promptTokens: 400, completionTokens: 5 })
        request.onFinish?.({
          promptTokens: 400,
          completionTokens: 5,
          totalPromptTokens: 721,
          totalCompletionTokens: 15
        })
        yield 'ok'
      }
    }),
    readToolModelSettings: () => ({
      providerName: 'tool-model',
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test',
      baseUrl: ''
    })
  })

  const result = await service.generateText({
    messages: [{ role: 'user', content: 'hello' }]
  })

  assert.equal(result.status, 'success')
  const usage =
    result.status === 'success'
      ? (result.usage as
          | (NonNullable<typeof result.usage> & { initialPromptTokens?: number })
          | undefined)
      : undefined
  assert.equal(usage?.initialPromptTokens, 321)
})

test('generateText runs a Codex OAuth tool model instead of blocking it', async () => {
  let capturedProvider: string | undefined

  const service = createAuxiliaryGenerationService({
    createModelRuntime: () => ({
      async *streamReply(request: ModelStreamRequest): AsyncIterable<string> {
        capturedProvider = request.settings.provider
        yield 'title'
      }
    }),
    // Codex authenticates via a session path rather than an apiKey.
    readToolModelSettings: () => ({
      providerName: 'codex',
      provider: 'openai-codex',
      model: 'gpt-5.1-codex-max',
      apiKey: '',
      baseUrl: '',
      codexSessionPath: '~/.codex/auth.json'
    })
  })

  const result = await service.generateText({
    messages: [{ role: 'user', content: 'Summarize this' }]
  })

  assert.equal(result.status, 'success')
  assert.equal(capturedProvider, 'openai-codex')
})
