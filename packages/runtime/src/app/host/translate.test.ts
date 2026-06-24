import assert from 'node:assert/strict'
import test from 'node:test'

import { translateWithRuntime } from './translate.ts'
import type { ModelRuntime, ModelStreamRequest } from '../../runtime/models/types.ts'

const request = { text: 'hello', targetLanguage: 'Japanese' }

test('translateWithRuntime runs a Codex OAuth tool model instead of blocking it', async () => {
  let capturedProvider: string | undefined

  const result = await translateWithRuntime({
    createModelRuntime: (): ModelRuntime => ({
      async *streamReply(req: ModelStreamRequest): AsyncIterable<string> {
        capturedProvider = req.settings.provider
        yield 'こんにちは'
      }
    }),
    onDelta: () => {},
    request,
    // Codex authenticates via a session path rather than an apiKey.
    settings: {
      providerName: 'codex',
      provider: 'openai-codex',
      model: 'gpt-5.1-codex-max',
      apiKey: '',
      baseUrl: '',
      codexSessionPath: '~/.codex/auth.json'
    }
  })

  assert.deepEqual(result, { status: 'success', translatedText: 'こんにちは' })
  assert.equal(capturedProvider, 'openai-codex')
})

test('translateWithRuntime reports not-configured when no tool model is set', async () => {
  const result = await translateWithRuntime({
    createModelRuntime: (): ModelRuntime => {
      throw new Error('Runtime should not be created when unavailable.')
    },
    onDelta: () => {},
    request,
    settings: null
  })

  assert.deepEqual(result, { status: 'unavailable', reason: 'not-configured' })
})
