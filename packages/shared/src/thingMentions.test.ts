import assert from 'node:assert/strict'
import test from 'node:test'

import { collectThingMentionSlugs, isThingMentionToken } from './thingMentions.ts'

test('collectThingMentionSlugs extracts unique Thing hashtag slugs', () => {
  assert.deepEqual(collectThingMentionSlugs('Use #raven-ui with #RAVEN-ui and #memoh_2026.'), [
    'raven-ui',
    'memoh_2026'
  ])
})

test('collectThingMentionSlugs ignores embedded hashtags and non-slug fragments', () => {
  assert.deepEqual(
    collectThingMentionSlugs('open https://example.test/#section and abc#raven plus #9bad'),
    []
  )
})

test('isThingMentionToken requires a valid Thing slug', () => {
  const validSlugs = new Set(['raven-ui'])

  assert.equal(isThingMentionToken('#raven-ui', validSlugs), true)
  assert.equal(isThingMentionToken('#Raven-UI', validSlugs), true)
  assert.equal(isThingMentionToken('#slus', validSlugs), false)
})
