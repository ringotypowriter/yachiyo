import assert from 'node:assert/strict'
import test from 'node:test'

import { estimateDraftPromptTokens } from './estimatePromptTokens.ts'

test('estimateDraftPromptTokens counts file drafts from attachment references, not base64 payloads', () => {
  const estimate = estimateDraftPromptTokens({
    text: 'Please review this attachment.',
    files: [
      {
        filename: 'report.pdf',
        mediaType: 'application/pdf',
        dataUrl: `data:application/pdf;base64,${'A'.repeat(800_000)}`
      }
    ]
  })

  assert.ok(
    estimate < 5_000,
    'draft attachment estimate should stay near the attached_files block size'
  )
})
