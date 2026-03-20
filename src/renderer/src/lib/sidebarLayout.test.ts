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
  assert.deepEqual(resolveSidebarLayout(true), {
    dividerOffset: SIDEBAR_WIDTH,
    mainHeaderPaddingLeft: 20,
    showDivider: true,
    sidebarWidth: SIDEBAR_WIDTH,
    toggleTitle: 'Hide sidebar'
  })
})

test('removes the sidebar width and divider when the sidebar is hidden', () => {
  assert.deepEqual(resolveSidebarLayout(false), {
    dividerOffset: null,
    mainHeaderPaddingLeft: 80,
    showDivider: false,
    sidebarWidth: 0,
    toggleTitle: 'Show sidebar'
  })
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
