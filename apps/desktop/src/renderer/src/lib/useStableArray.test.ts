import assert from 'node:assert/strict'
import test from 'node:test'

import { arraysShallowEqual } from './useStableArray.ts'

test('arraysShallowEqual', async (t) => {
  await t.test('equal references and equal elements compare true', () => {
    const shared = ['a', 'b']
    assert.equal(arraysShallowEqual(shared, shared), true)
    assert.equal(arraysShallowEqual(['a', 'b'], ['a', 'b']), true)
    assert.equal(arraysShallowEqual([], []), true)
  })

  await t.test('length or element differences compare false', () => {
    assert.equal(arraysShallowEqual(['a'], ['a', 'b']), false)
    assert.equal(arraysShallowEqual(['a', 'b'], ['a', 'c']), false)
  })

  await t.test('elements are compared by reference, not deep equality', () => {
    const item = { id: 1 }
    assert.equal(arraysShallowEqual([item], [item]), true)
    assert.equal(arraysShallowEqual([{ id: 1 }], [{ id: 1 }]), false)
  })
})
