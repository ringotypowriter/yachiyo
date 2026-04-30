import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTimelineVirtualRowStyle } from './messageTimelineRowStyle.ts'

test('virtual timeline row style does not animate remounted history rows', () => {
  const style = buildTimelineVirtualRowStyle(240)

  assert.deepEqual(style, {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    transform: 'translateY(240px)',
    contain: 'content'
  })
  assert.equal('animation' in style, false)
})
