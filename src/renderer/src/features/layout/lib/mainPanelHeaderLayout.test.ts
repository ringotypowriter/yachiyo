import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldShowCenteredHeaderAccessory } from './mainPanelHeaderLayout.ts'

test('hidden sidebar shows the centered accessory when browser sessions exist', () => {
  assert.equal(
    shouldShowCenteredHeaderAccessory({ showSidebarToggle: true, hasCenterAccessory: true }),
    true
  )
})

test('visible sidebar keeps the centered accessory in the normal center status slot', () => {
  assert.equal(
    shouldShowCenteredHeaderAccessory({ showSidebarToggle: false, hasCenterAccessory: true }),
    false
  )
})

test('hidden sidebar keeps the centered title when there is no accessory', () => {
  assert.equal(
    shouldShowCenteredHeaderAccessory({ showSidebarToggle: true, hasCenterAccessory: false }),
    false
  )
})
