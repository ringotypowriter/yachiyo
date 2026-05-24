import assert from 'node:assert/strict'
import test from 'node:test'
import {
  APP_TABS,
  appTabForThreadListMode,
  resolveAppTabBarBottomTools,
  threadListModeForAppTab,
  type AppTabId
} from './appTabs.ts'

test('app tabs expose Chat, Archived, and Settings in order', () => {
  assert.deepEqual(
    APP_TABS.map((tab) => tab.id),
    ['chat', 'archived', 'settings'] satisfies AppTabId[]
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

test('tabbar bottom tools keep ellipsis at the lowest position', () => {
  assert.deepEqual(resolveAppTabBarBottomTools(false), ['more'])
  assert.deepEqual(resolveAppTabBarBottomTools(true), ['update', 'more'])
})
