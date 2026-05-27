import assert from 'node:assert/strict'
import test from 'node:test'

import { assertConfigured } from './languageModel.ts'

test('assertConfigured allows Codex OAuth with a session path and no API key', () => {
  assert.doesNotThrow(() =>
    assertConfigured({
      providerName: 'codex',
      provider: 'openai-codex',
      model: 'gpt-5.1-codex-max',
      apiKey: '',
      baseUrl: '',
      codexSessionPath: '~/.codex/auth.json'
    })
  )
})

test('assertConfigured rejects Codex OAuth without a session path', () => {
  assert.throws(
    () =>
      assertConfigured({
        providerName: 'codex',
        provider: 'openai-codex',
        model: 'gpt-5.1-codex-max',
        apiKey: '',
        baseUrl: ''
      }),
    {
      message:
        'No Codex session path configured. Open Settings and set the path to your Codex auth.json.'
    }
  )
})
