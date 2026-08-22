import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SettingsConfig } from '@yachiyo/shared/protocol'

import {
  getDirtySettingsPanels,
  panelSupportsDrafts,
  type SettingsDirtyInput
} from './settingsDirtyPanels.ts'

function baseConfig(): SettingsConfig {
  return {
    providers: [],
    general: {
      themeId: 'mizu',
      updateChannel: 'stable',
      activityTracking: { mode: 'simple' },
      demoMode: false
    },
    chat: { recapEnabled: true, autoMemoryDistillation: true },
    memory: { enabled: true, autoRecall: true },
    skills: { enabled: [] },
    prompts: []
  }
}

function input(overrides: Partial<SettingsDirtyInput> = {}): SettingsDirtyInput {
  return {
    savedConfig: baseConfig(),
    draftConfig: baseConfig(),
    isChannelsDirty: false,
    isUserDocumentDirty: false,
    isSoulDocumentDirty: false,
    ...overrides
  }
}

test('reports no dirty panels when the draft matches the saved config', () => {
  assert.deepEqual([...getDirtySettingsPanels(input())], [])
})

test('reports no dirty panels before the config has loaded', () => {
  assert.deepEqual([...getDirtySettingsPanels(input({ savedConfig: null, draftConfig: null }))], [])
})

test('attributes a general appearance change to the general panel only', () => {
  const draftConfig = baseConfig()
  draftConfig.general!.uiFontSize = 16

  assert.deepEqual([...getDirtySettingsPanels(input({ draftConfig }))], ['general'])
})

test('attributes context time zone changes to the general panel', () => {
  const draftConfig = baseConfig()
  draftConfig.general!.contextTimeZone = 'Asia/Shanghai'

  assert.deepEqual([...getDirtySettingsPanels(input({ draftConfig }))], ['general'])
})

test('attributes activity tracking to sources even though it lives under general', () => {
  const draftConfig = baseConfig()
  draftConfig.general!.activityTracking = { mode: 'off' }

  assert.deepEqual([...getDirtySettingsPanels(input({ draftConfig }))], ['source'])
})

test('attributes demo mode to about even though it lives under general', () => {
  const draftConfig = baseConfig()
  draftConfig.general!.demoMode = true

  assert.deepEqual([...getDirtySettingsPanels(input({ draftConfig }))], ['about'])
})

test('attributes memory distillation to sources even though it lives under chat', () => {
  const draftConfig = baseConfig()
  draftConfig.chat!.autoMemoryDistillation = false

  assert.deepEqual([...getDirtySettingsPanels(input({ draftConfig }))], ['source'])
})

test('attributes conversation settings to the chat panel', () => {
  const draftConfig = baseConfig()
  draftConfig.chat!.recapEnabled = false

  assert.deepEqual([...getDirtySettingsPanels(input({ draftConfig }))], ['chat'])
})

test('attributes provider edits to the providers panel', () => {
  const draftConfig = baseConfig()
  draftConfig.providers = [
    {
      id: 'p1',
      name: 'Anthropic',
      type: 'anthropic',
      apiKey: '',
      baseUrl: '',
      modelList: { enabled: [], disabled: [] }
    }
  ]

  assert.deepEqual([...getDirtySettingsPanels(input({ draftConfig }))], ['providers'])
})

test('attributes prompts and workspace edits to the capabilities panel', () => {
  const draftConfig = baseConfig()
  draftConfig.prompts = [{ keycode: 'ship', text: 'ship it' }]

  assert.deepEqual([...getDirtySettingsPanels(input({ draftConfig }))], ['capabilities'])
})

test('marks channels dirty from the channels draft flag', () => {
  assert.deepEqual([...getDirtySettingsPanels(input({ isChannelsDirty: true }))], ['channels'])
})

test('maps USER.md and SOUL.md drafts onto the general panel', () => {
  assert.deepEqual([...getDirtySettingsPanels(input({ isUserDocumentDirty: true }))], ['general'])
  assert.deepEqual([...getDirtySettingsPanels(input({ isSoulDocumentDirty: true }))], ['general'])
})

test('reports every affected panel when changes span panels', () => {
  const draftConfig = baseConfig()
  draftConfig.chat!.recapEnabled = false
  draftConfig.general!.demoMode = true

  const dirty = getDirtySettingsPanels(input({ draftConfig, isChannelsDirty: true }))
  assert.deepEqual([...dirty].sort(), ['about', 'channels', 'chat'])
})

test('panels that persist immediately do not support drafts', () => {
  assert.equal(panelSupportsDrafts('schedules'), false)
  assert.equal(panelSupportsDrafts('sync'), false)
  assert.equal(panelSupportsDrafts('usage'), false)
})

test('panels backed by the settings draft support drafts', () => {
  for (const panel of [
    'general',
    'providers',
    'chat',
    'capabilities',
    'source',
    'channels',
    'about'
  ] as const) {
    assert.equal(panelSupportsDrafts(panel), true, panel)
  }
})
