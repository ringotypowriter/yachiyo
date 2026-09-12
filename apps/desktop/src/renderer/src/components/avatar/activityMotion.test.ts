import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { getActivityEyeShape, getRestingTurn, getWinkEyeWeight } from './activityMotion.ts'
import { YachiyoAvatar } from './YachiyoAvatar.tsx'

test('thinking has tall oval eyes while working has a flatter focused shape', () => {
  const thinking = getActivityEyeShape('thinking')
  const working = getActivityEyeShape('working')
  assert.ok(thinking.height > 1.3 && thinking.width < 1)
  assert.ok(working.width > 1 && working.height < 1)
  assert.deepEqual(getActivityEyeShape('idle'), { width: 1, height: 1 })
})

test('waiting opens both eyes wider and taller than idle without narrowing like thinking', () => {
  const waiting = getActivityEyeShape('waiting')
  assert.ok(waiting.width > 1 && waiting.height > 1.5)
  assert.ok(waiting.width > getActivityEyeShape('thinking').width)
  assert.deepEqual(getActivityEyeShape('idle'), { width: 1, height: 1 })
})

test('only waiting has a dedicated status dot', () => {
  for (const phase of [
    'idle',
    'loading',
    'thinking',
    'speaking',
    'working',
    'waiting',
    'success'
  ] as const) {
    const html = renderToStaticMarkup(React.createElement(YachiyoAvatar, { phase }))
    assert.equal(html.includes('yachiyo-avatar__waiting-dot'), phase === 'waiting')
  }
})

test('an interrupted turn settles by at most half a revolution', () => {
  for (const angle of [-400, -9, 0, 85, 170, 210, 340, 368, 730]) {
    const rest = getRestingTurn(angle)
    assert.equal(Math.abs(rest % 360), 0)
    assert.ok(Math.abs(rest - angle) <= 180)
  }
})

test('activity eye shaping yields to wink and returns smoothly at the endpoints', () => {
  assert.equal(getWinkEyeWeight(0), 1)
  assert.equal(getWinkEyeWeight(1), 1)
  assert.equal(getWinkEyeWeight(0.5), 0)
  assert.ok(getWinkEyeWeight(0.08) > 0 && getWinkEyeWeight(0.08) < 1)
})
