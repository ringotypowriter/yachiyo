import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SETTINGS_TABS,
  getInitialSettingsSubTabs,
  resolveSettingsRoute
} from './settingsNavigation.ts'

test('settings navigation groups related panes under fewer top-level tabs', () => {
  assert.deepEqual(
    SETTINGS_TABS.map((tab) => tab.id),
    [
      'general',
      'providers',
      'chat',
      'capabilities',
      'source',
      'channels',
      'schedules',
      'usage',
      'about'
    ]
  )
})

test('settings navigation initializes grouped default sub-tabs', () => {
  assert.deepEqual(getInitialSettingsSubTabs(), {
    general: 'general',
    chat: 'threads',
    capabilities: 'skills',
    source: 'memory',
    channels: 'general',
    schedules: 'list',
    usage: 'usage'
  })
})

test('settings navigation maps old pane ids into their new grouped tabs', () => {
  assert.deepEqual(resolveSettingsRoute('ui'), { tab: 'general', subTab: 'ui' })
  assert.deepEqual(resolveSettingsRoute('essentials'), { tab: 'chat', subTab: 'essentials' })
  assert.deepEqual(resolveSettingsRoute('skills'), { tab: 'capabilities', subTab: 'skills' })
  assert.deepEqual(resolveSettingsRoute('coding-agents'), {
    tab: 'capabilities',
    subTab: 'coding-agents'
  })
  assert.deepEqual(resolveSettingsRoute('prompts'), { tab: 'capabilities', subTab: 'prompts' })
  assert.deepEqual(resolveSettingsRoute('workspace'), { tab: 'capabilities', subTab: 'workspace' })
  assert.deepEqual(resolveSettingsRoute('memory'), { tab: 'source', subTab: 'memory' })
  assert.deepEqual(resolveSettingsRoute('search'), { tab: 'source', subTab: 'search' })
  assert.deepEqual(resolveSettingsRoute('activity'), { tab: 'source', subTab: 'activity' })
})

test('settings navigation accepts grouped tab routes from external entry points', () => {
  assert.deepEqual(resolveSettingsRoute('general/ui'), { tab: 'general', subTab: 'ui' })
  assert.deepEqual(resolveSettingsRoute('chat/essentials'), { tab: 'chat', subTab: 'essentials' })
  assert.deepEqual(resolveSettingsRoute('capabilities/skills'), {
    tab: 'capabilities',
    subTab: 'skills'
  })
  assert.deepEqual(resolveSettingsRoute('capabilities/workspace'), {
    tab: 'capabilities',
    subTab: 'workspace'
  })
  assert.deepEqual(resolveSettingsRoute('source/search'), { tab: 'source', subTab: 'search' })
  assert.deepEqual(resolveSettingsRoute('source/activity'), { tab: 'source', subTab: 'activity' })
})

test('settings navigation falls back to general for unknown routes', () => {
  assert.deepEqual(resolveSettingsRoute('not-real'), { tab: 'general' })
  assert.deepEqual(resolveSettingsRoute('chat'), { tab: 'chat' })
})
