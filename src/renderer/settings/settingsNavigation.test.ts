import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SETTINGS_PANELS,
  getInitialSettingsPanelTabs,
  resolveSettingsRoute,
  serializeSettingsRoute
} from './settingsNavigation.ts'

test('settings navigation groups related panes under fewer top-level panels', () => {
  assert.deepEqual(
    SETTINGS_PANELS.map((panel) => panel.id),
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

test('general panel exposes behavior and user interface tabs', () => {
  const generalPanel = SETTINGS_PANELS.find((panel) => panel.id === 'general')

  assert.deepEqual(
    generalPanel?.tabs?.map(({ id, label }) => ({ id, label })),
    [
      { id: 'behavior', label: 'Behavior' },
      { id: 'ui', label: 'User Interface' }
    ]
  )
})

test('settings navigation initializes grouped default panel tabs', () => {
  assert.deepEqual(getInitialSettingsPanelTabs(), {
    general: 'behavior',
    chat: 'threads',
    capabilities: 'skills',
    source: 'memory',
    channels: 'general',
    schedules: 'list',
    usage: 'usage'
  })
})

test('settings navigation maps old pane ids into their grouped panels and tabs', () => {
  assert.deepEqual(resolveSettingsRoute('behavior'), { panel: 'general', tab: 'behavior' })
  assert.deepEqual(resolveSettingsRoute('ui'), { panel: 'general', tab: 'ui' })
  assert.deepEqual(resolveSettingsRoute('essentials'), { panel: 'chat', tab: 'essentials' })
  assert.deepEqual(resolveSettingsRoute('skills'), { panel: 'capabilities', tab: 'skills' })
  assert.deepEqual(resolveSettingsRoute('coding-agents'), {
    panel: 'capabilities',
    tab: 'coding-agents'
  })
  assert.deepEqual(resolveSettingsRoute('prompts'), { panel: 'capabilities', tab: 'prompts' })
  assert.deepEqual(resolveSettingsRoute('workspace'), { panel: 'capabilities', tab: 'workspace' })
  assert.deepEqual(resolveSettingsRoute('memory'), { panel: 'source', tab: 'memory' })
  assert.deepEqual(resolveSettingsRoute('search'), { panel: 'source', tab: 'search' })
  assert.deepEqual(resolveSettingsRoute('activity'), { panel: 'source', tab: 'activity' })
})

test('settings navigation accepts panel tab routes from external entry points', () => {
  assert.deepEqual(resolveSettingsRoute('general/behavior'), { panel: 'general', tab: 'behavior' })
  assert.deepEqual(resolveSettingsRoute('general/general'), { panel: 'general', tab: 'behavior' })
  assert.deepEqual(resolveSettingsRoute('general/ui'), { panel: 'general', tab: 'ui' })
  assert.deepEqual(resolveSettingsRoute('chat/essentials'), { panel: 'chat', tab: 'essentials' })
  assert.deepEqual(resolveSettingsRoute('capabilities/skills'), {
    panel: 'capabilities',
    tab: 'skills'
  })
  assert.deepEqual(resolveSettingsRoute('capabilities/workspace'), {
    panel: 'capabilities',
    tab: 'workspace'
  })
  assert.deepEqual(resolveSettingsRoute('source/search'), { panel: 'source', tab: 'search' })
  assert.deepEqual(resolveSettingsRoute('source/activity'), { panel: 'source', tab: 'activity' })
})

test('settings navigation serializes panel routes consistently', () => {
  assert.equal(serializeSettingsRoute('general'), 'general')
  assert.equal(serializeSettingsRoute('general', 'behavior'), 'general/behavior')
})

test('settings navigation falls back to general for unknown routes', () => {
  assert.deepEqual(resolveSettingsRoute('not-real'), { panel: 'general' })
  assert.deepEqual(resolveSettingsRoute('chat'), { panel: 'chat' })
})
