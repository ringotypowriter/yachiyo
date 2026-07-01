import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  AuxiliaryGenerationService,
  AuxiliaryTextGenerationRequest
} from '../../runtime/models/auxiliaryGeneration.ts'
import { createImageToTextService } from './imageToTextService.ts'

const pngDataUrl =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lVx9wQAAAABJRU5ErkJggg=='

test('image-to-text can use an openai-codex model override without a title token cap', async () => {
  let capturedRequest: AuxiliaryTextGenerationRequest | undefined

  const auxService: AuxiliaryGenerationService = {
    async generateText(request) {
      capturedRequest = request
      return {
        status: 'success',
        settings: request.settingsOverride!,
        text: 'A tiny red pixel.'
      }
    }
  }

  const service = createImageToTextService({
    auxService,
    resolveSettings: () => ({
      providerName: 'codex',
      provider: 'openai-codex',
      model: 'gpt-5.4-mini',
      apiKey: '',
      baseUrl: '',
      codexSessionPath: '~/.codex/auth.json'
    })
  })

  const result = await service.describe(pngDataUrl, 'sample')

  assert.equal(result?.altText, 'A tiny red pixel.')
  assert.equal(capturedRequest?.purpose, 'image-to-text')
  assert.equal(capturedRequest?.settingsOverride?.provider, 'openai-codex')
  assert.equal(capturedRequest?.settingsOverride?.model, 'gpt-5.4-mini')
  assert.equal(capturedRequest?.max_token, undefined)
})
