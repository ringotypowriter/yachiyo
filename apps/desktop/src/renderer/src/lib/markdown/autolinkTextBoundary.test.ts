import assert from 'node:assert/strict'
import test from 'node:test'

import { splitAutolinkCandidate } from './autolinkTextBoundary.ts'

test('splitAutolinkCandidate separates adjacent Chinese text from URL text', () => {
  assert.deepEqual(splitAutolinkCandidate('https://example.com/path中文内容'), {
    url: 'https://example.com/path',
    trailingText: '中文内容'
  })
})

test('splitAutolinkCandidate keeps ASCII URL suffixes inside URL text', () => {
  assert.deepEqual(splitAutolinkCandidate('https://example.com/a?x=1&y=2#top'), {
    url: 'https://example.com/a?x=1&y=2#top',
    trailingText: ''
  })
})

test('splitAutolinkCandidate rejects code text with spaces', () => {
  assert.equal(splitAutolinkCandidate('https://example.com/path with text'), null)
})
