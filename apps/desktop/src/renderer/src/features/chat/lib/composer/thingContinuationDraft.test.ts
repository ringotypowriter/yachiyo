import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveLeadingThingHashtagCursorOffset } from './thingContinuationDraft.ts'

test('places the continuation cursor after the leading Thing hashtag', () => {
  assert.equal(resolveLeadingThingHashtagCursorOffset('#raven-ui '), '#raven-ui '.length)
  assert.equal(resolveLeadingThingHashtagCursorOffset('#raven-ui next step'), '#raven-ui '.length)
  assert.equal(resolveLeadingThingHashtagCursorOffset('plain draft'), 'plain draft'.length)
})
