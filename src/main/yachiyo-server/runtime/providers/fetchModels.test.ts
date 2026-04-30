import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchModels } from './fetchModels.ts'

test('fetchModels requires a Codex session path when Codex OAuth has no API key', async () => {
  await assert.rejects(
    () =>
      fetchModels(
        {
          id: 'provider-codex',
          name: 'Codex',
          type: 'openai-codex',
          apiKey: '',
          baseUrl: '',
          modelList: {
            enabled: [],
            disabled: []
          }
        },
        (async () => {
          throw new Error('Fetch should not be called without Codex credentials.')
        }) as typeof globalThis.fetch
      ),
    {
      message: 'Codex session path is required'
    }
  )
})
