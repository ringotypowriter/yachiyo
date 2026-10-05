import assert from 'node:assert/strict'
import test from 'node:test'
import { appendConfirmedRenderUiText, parseRenderUiOutput } from './renderUiBoundary.ts'

test('validates and clamps iframe height', () => {
  assert.deepEqual(parseRenderUiOutput({ type: 'height', height: 100 }), {
    type: 'height',
    height: 160
  })
  assert.deepEqual(parseRenderUiOutput({ type: 'height', height: 1137 }), {
    type: 'height',
    height: 1137
  })
  assert.deepEqual(parseRenderUiOutput({ type: 'height', height: 99999 }), {
    type: 'height',
    height: 1600
  })
  assert.equal(parseRenderUiOutput({ type: 'height', height: Infinity }), null)
})

test('rejects unsafe links and malformed actions at the untrusted port boundary', () => {
  assert.equal(parseRenderUiOutput({ type: 'openLink', url: 'javascript:alert(1)' }), null)
  assert.equal(parseRenderUiOutput({ type: 'openLink', url: 'file:///etc/passwd' }), null)
  assert.deepEqual(parseRenderUiOutput({ type: 'openLink', url: 'https://example.com/a' }), {
    type: 'openLink',
    url: 'https://example.com/a'
  })
  assert.equal(parseRenderUiOutput({ type: 'continueConversation', text: 42 }), null)
  assert.equal(parseRenderUiOutput({ type: 'error', message: 'x'.repeat(3000) }), null)
})

test('confirmation appends to only the originating conversation and preserves attachments', () => {
  const drafts = {
    first: { text: 'Original', images: [{ id: 'photo' }], files: [{ id: 'file' }] },
    second: { text: 'Other', images: [], files: [] }
  }
  assert.deepEqual(appendConfirmedRenderUiText(drafts, 'first', 'Proposed', drafts.first), {
    first: { text: 'Original\nProposed', images: [{ id: 'photo' }], files: [{ id: 'file' }] },
    second: drafts.second
  })
})
