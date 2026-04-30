import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_ENABLED_TOOL_NAMES } from '../../../shared/yachiyo/protocol.ts'
import {
  SIDEBAR_WIDTH,
  applySidebarVisibilityPreference,
  parseStoredSidebarVisibility,
  resolveSidebarVisibilityPreference,
  resolveSidebarLayout
} from './sidebarLayout.ts'

test('keeps the sidebar width and divider when the sidebar is open', () => {
  const layout = resolveSidebarLayout(true)
  assert.equal(layout.dividerOffset, SIDEBAR_WIDTH)
  assert.equal(layout.mainHeaderPaddingLeft, 20)
  assert.equal(layout.showDivider, true)
  assert.equal(layout.sidebarWidth, SIDEBAR_WIDTH)
})

test('removes the sidebar width and divider when the sidebar is hidden', () => {
  const layout = resolveSidebarLayout(false)
  assert.equal(layout.dividerOffset, null)
  assert.equal(layout.mainHeaderPaddingLeft, 80)
  assert.equal(layout.showDivider, false)
  assert.equal(layout.sidebarWidth, 0)
})

test('applies sidebar visibility without dropping the rest of the shared config', () => {
  assert.deepEqual(
    applySidebarVisibilityPreference(
      {
        enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
        general: {
          sidebarVisibility: 'expanded'
        },
        chat: {
          activeRunEnterBehavior: 'enter-queues-follow-up'
        },
        providers: []
      },
      'collapsed'
    ),
    {
      enabledTools: DEFAULT_ENABLED_TOOL_NAMES,
      general: {
        sidebarVisibility: 'collapsed'
      },
      chat: {
        activeRunEnterBehavior: 'enter-queues-follow-up'
      },
      providers: []
    }
  )
})

test('falls back to the cached sidebar visibility before shared config has loaded', () => {
  assert.equal(resolveSidebarVisibilityPreference(null, 'collapsed'), 'collapsed')
  assert.equal(resolveSidebarVisibilityPreference(undefined, 'expanded'), 'expanded')
})

test('parses only valid stored sidebar visibility values', () => {
  assert.equal(parseStoredSidebarVisibility('collapsed'), 'collapsed')
  assert.equal(parseStoredSidebarVisibility('expanded'), 'expanded')
  assert.equal(parseStoredSidebarVisibility(''), null)
  assert.equal(parseStoredSidebarVisibility('sideways'), null)
  assert.equal(parseStoredSidebarVisibility(null), null)
})
