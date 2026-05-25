import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APP_TAB_BAR_WIDTH,
  APP_TRAFFIC_LIGHT_SAFE_WIDTH,
  APP_TABS,
  appTabForThreadListMode,
  resolveAppTabBarBottomTools,
  resolveAppTabFrameSidebarDividerOffset,
  resolveAppTabFrameTopChromeColumn,
  shouldShowAppTabFrameSidebarTopControls,
  threadListModeForAppTab,
  type AppTabId
} from './appTabs.ts'

test('app tabs expose Work, Archived, and Settings in order', () => {
  assert.deepEqual(
    APP_TABS.map((tab) => tab.id),
    ['chat', 'archived', 'settings'] satisfies AppTabId[]
  )
  assert.deepEqual(
    APP_TABS.map((tab) => tab.label),
    ['Work', 'Archived', 'Settings']
  )
})

test('thread list mode maps to the owning app tab', () => {
  assert.equal(appTabForThreadListMode('active'), 'chat')
  assert.equal(appTabForThreadListMode('archived'), 'archived')
})

test('app tabs resolve the thread list mode they own', () => {
  assert.equal(threadListModeForAppTab('chat'), 'active')
  assert.equal(threadListModeForAppTab('archived'), 'archived')
  assert.equal(threadListModeForAppTab('settings'), null)
})

test('compact app tab rail is narrower than the macOS traffic-light safe area', () => {
  assert.ok(APP_TAB_BAR_WIDTH < APP_TRAFFIC_LIGHT_SAFE_WIDTH)
})

test('sidebar divider offsets include the compact app rail width', () => {
  assert.equal(resolveAppTabFrameSidebarDividerOffset(null), null)
  assert.equal(resolveAppTabFrameSidebarDividerOffset(260), APP_TAB_BAR_WIDTH + 260)
})

test('tabbar bottom tools keep ellipsis at the lowest position', () => {
  assert.deepEqual(resolveAppTabBarBottomTools(false), ['more'])
  assert.deepEqual(resolveAppTabBarBottomTools(true), ['update', 'more'])
})

test('app frame hides sidebar top controls when sidebar is collapsed', () => {
  assert.equal(shouldShowAppTabFrameSidebarTopControls(false), false)
  assert.equal(shouldShowAppTabFrameSidebarTopControls(true), true)
})

test('app frame top chrome stays out of the main column when sidebar is open', () => {
  assert.equal(resolveAppTabFrameTopChromeColumn(true), '1 / 3')
  assert.equal(resolveAppTabFrameTopChromeColumn(false), '1 / 4')
})
