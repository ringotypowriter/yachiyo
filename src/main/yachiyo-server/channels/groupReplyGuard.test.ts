import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  GROUP_REPLY_DEDUP_WINDOW_MS,
  hasForbiddenGroupReplyPrefix,
  isNearDuplicateGroupReply,
  normalizeGroupReplyForComparison
} from './groupReplyGuard.ts'

describe('GROUP_REPLY_DEDUP_WINDOW_MS', () => {
  it('keeps recent outgoing replies for 30 minutes', () => {
    assert.equal(GROUP_REPLY_DEDUP_WINDOW_MS, 30 * 60 * 1_000)
  })
})

describe('hasForbiddenGroupReplyPrefix', () => {
  it('rejects replies that start with an ASCII colon', () => {
    assert.equal(hasForbiddenGroupReplyPrefix(':hello there'), true)
  })

  it('rejects replies that start with a full-width colon after whitespace', () => {
    assert.equal(hasForbiddenGroupReplyPrefix('   ：hello there'), true)
  })

  it('allows normal replies', () => {
    assert.equal(hasForbiddenGroupReplyPrefix('hello there'), false)
  })
})

describe('normalizeGroupReplyForComparison', () => {
  it('strips leading colons and collapses whitespace', () => {
    assert.equal(normalizeGroupReplyForComparison('  ：  hello   there  '), 'hello there')
  })
})

describe('isNearDuplicateGroupReply', () => {
  it('treats colon-prefixed variants as duplicates', () => {
    assert.equal(isNearDuplicateGroupReply(':hello there', 'hello there'), true)
  })

  it('treats whitespace-only variants as duplicates', () => {
    assert.equal(isNearDuplicateGroupReply('hello there', '  hello   there '), true)
  })

  it('keeps distinct replies distinct', () => {
    assert.equal(isNearDuplicateGroupReply('hello there', 'different reply'), false)
  })
})
