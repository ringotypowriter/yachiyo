import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  GROUP_REPLY_MAX_CHARS,
  hasForbiddenGroupReplyPrefix,
  hasVisibleGroupReplyContent,
  isOverlongGroupReply
} from './groupReplyGuard.ts'

describe('isOverlongGroupReply', () => {
  it('allows a short chat sentence', () => {
    assert.equal(isOverlongGroupReply('这猫脸也太臭了哈哈'), false)
  })

  it('allows exactly the limit', () => {
    assert.equal(isOverlongGroupReply('字'.repeat(GROUP_REPLY_MAX_CHARS)), false)
  })

  it('rejects one code point over the limit', () => {
    assert.equal(isOverlongGroupReply('字'.repeat(GROUP_REPLY_MAX_CHARS + 1)), true)
  })

  it('counts code points, not UTF-16 units', () => {
    // Astral-plane emoji are 2 UTF-16 units but 1 code point each.
    assert.equal(isOverlongGroupReply('😹'.repeat(GROUP_REPLY_MAX_CHARS)), false)
  })

  it('ignores surrounding whitespace', () => {
    assert.equal(isOverlongGroupReply(`  ${'字'.repeat(GROUP_REPLY_MAX_CHARS)}  `), false)
  })
})

describe('hasForbiddenGroupReplyPrefix', () => {
  it('rejects replies that start with an ASCII colon', () => {
    assert.equal(hasForbiddenGroupReplyPrefix(':hello there'), true)
  })

  it('rejects replies that start with a full-width colon after whitespace', () => {
    assert.equal(hasForbiddenGroupReplyPrefix('   ：hello there'), true)
  })

  it('rejects replies that start with a closing brace after whitespace', () => {
    assert.equal(hasForbiddenGroupReplyPrefix('   }hello there'), true)
  })

  it('allows normal replies', () => {
    assert.equal(hasForbiddenGroupReplyPrefix('hello there'), false)
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
