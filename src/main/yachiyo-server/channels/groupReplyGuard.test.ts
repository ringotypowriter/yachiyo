import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { hasForbiddenGroupReplyPrefix, hasVisibleGroupReplyContent } from './groupReplyGuard.ts'

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
