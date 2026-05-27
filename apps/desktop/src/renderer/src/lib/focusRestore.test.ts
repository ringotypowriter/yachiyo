import assert from 'node:assert/strict'
import test from 'node:test'

import { restoreFocusToElement, type RestorableFocusElement } from './focusRestore.ts'

function focusElement(isConnected: boolean): RestorableFocusElement & {
  focusCalls: FocusOptions[]
} {
  return {
    isConnected,
    focusCalls: [],
    focus(options?: FocusOptions): void {
      this.focusCalls.push(options ?? {})
    }
  }
}

test('restoreFocusToElement restores connected focus target without scrolling', () => {
  const target = focusElement(true)

  assert.equal(restoreFocusToElement(target), true)
  assert.deepEqual(target.focusCalls, [{ preventScroll: true }])
})

test('restoreFocusToElement ignores missing focus target', () => {
  assert.equal(restoreFocusToElement(null), false)
})

test('restoreFocusToElement ignores disconnected focus target', () => {
  const target = focusElement(false)

  assert.equal(restoreFocusToElement(target), false)
  assert.deepEqual(target.focusCalls, [])
})
