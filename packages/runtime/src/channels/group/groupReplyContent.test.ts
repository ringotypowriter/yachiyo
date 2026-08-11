import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { prepareGroupReplyForDelivery } from './groupReplyContent.ts'

describe('prepareGroupReplyForDelivery', () => {
  it('preserves visible chat text instead of enforcing a mechanical style', () => {
    const message = `：我先把这个例子说完
}这一行也是我真的想发的，长一点、换行或用什么标点都不该让代码替我改口。`

    assert.equal(prepareGroupReplyForDelivery(message), message)
  })

  it('rejects content that would render as an empty message', () => {
    assert.equal(prepareGroupReplyForDelivery('  \n\t\u200B\u200D\u2060\uFEFF  '), null)
  })
})
