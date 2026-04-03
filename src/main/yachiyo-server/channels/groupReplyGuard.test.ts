import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  appendGroupReplyHistory,
  GROUP_REPLY_DEDUP_WINDOW_MS,
  hasForbiddenGroupReplyPrefix,
  hasVisibleGroupReplyContent,
  isNearDuplicateGroupReply,
  normalizeGroupReplyForComparison,
  shouldSuppressGroupReply
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

  it('drops invisible-only characters to an empty comparison key', () => {
    assert.equal(normalizeGroupReplyForComparison('\u200B\u200D\u2060\uFEFF'), '')
  })
})

describe('hasVisibleGroupReplyContent', () => {
  it('rejects whitespace-only replies', () => {
    assert.equal(hasVisibleGroupReplyContent('   \n\t  '), false)
  })

  it('rejects invisible-only replies', () => {
    assert.equal(hasVisibleGroupReplyContent('\u200B\u200D\u2060\uFEFF'), false)
  })

  it('allows replies with visible text', () => {
    assert.equal(hasVisibleGroupReplyContent(' \u200B hello \u200D '), true)
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

describe('group reply history', () => {
  it('does not suppress a restored reply that is older than the dedup window', () => {
    const nowMs = Date.UTC(2026, 3, 3, 12, 0, 0)
    const oldSentAtMs = nowMs - GROUP_REPLY_DEDUP_WINDOW_MS - 1
    const history = appendGroupReplyHistory(undefined, 'hello there', oldSentAtMs)

    assert.equal(shouldSuppressGroupReply(history, 'hello there', nowMs), false)
    assert.deepEqual(history, { texts: [], timestamps: [] })
  })

  it('suppresses a restored reply that is still within the dedup window', () => {
    const nowMs = Date.UTC(2026, 3, 3, 12, 0, 0)
    const recentSentAtMs = nowMs - GROUP_REPLY_DEDUP_WINDOW_MS + 1
    const history = appendGroupReplyHistory(undefined, 'hello there', recentSentAtMs)

    assert.equal(shouldSuppressGroupReply(history, ' : hello   there ', nowMs), true)
  })
})
