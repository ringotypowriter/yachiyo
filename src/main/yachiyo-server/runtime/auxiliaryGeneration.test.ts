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
