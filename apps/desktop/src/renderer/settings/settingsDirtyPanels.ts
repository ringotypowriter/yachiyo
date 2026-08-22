import type { ChatConfig, GeneralConfig, SettingsConfig } from '@yachiyo/shared/protocol'

import { SETTINGS_PANELS, type SettingsPanelId } from './settingsNavigation.ts'

export interface SettingsDirtyInput {
  savedConfig: SettingsConfig | null
  draftConfig: SettingsConfig | null
  isChannelsDirty: boolean
  isUserDocumentDirty: boolean
  isSoulDocumentDirty: boolean
}

/**
 * Panels whose changes persist the moment you make them (schedule CRUD, sync operations,
 * read-only reports). They never contribute to the settings draft, so the window chrome must
 * not offer Save/Discard while they are open.
 */
const DRAFTLESS_PANELS: ReadonlySet<SettingsPanelId> = new Set<SettingsPanelId>([
  'schedules',
  'sync',
  'usage'
])

/**
 * Which panel owns which slice of the config. Several settings live under a config key that does
 * not match the panel that edits them — activity tracking and demo mode sit under `general`,
 * memory distillation sits under `chat` — so ownership is declared explicitly rather than
 * inferred from the config shape.
 */
const ROOT_KEYS_BY_PANEL: Partial<Record<SettingsPanelId, readonly (keyof SettingsConfig)[]>> = {
  providers: ['providers'],
  chat: ['defaultModel', 'toolModel', 'essentials'],
  capabilities: ['skills', 'subagents', 'subagentProfiles', 'prompts', 'workspace'],
  source: ['memory', 'webSearch']
}

const GENERAL_KEYS_BY_PANEL: Partial<Record<SettingsPanelId, readonly (keyof GeneralConfig)[]>> = {
  general: [
    'sidebarVisibility',
    'language',
    'sidebarPreview',
    'workSummary',
    'themeId',
    'themeAppearance',
    'uiFontSize',
    'chatFontSize',
    'chatPanelOpacity',
    'updateChannel',
    'preventSystemSleep',
    'notifyRunCompleted',
    'notifyCodingTaskStarted',
    'notifyCodingTaskFinished',
    'translatorShortcut',
    'jotdownShortcut',
    'contextTimeZone'
  ],
  source: ['activityTracking'],
  about: ['demoMode']
}

const CHAT_KEYS_BY_PANEL: Partial<Record<SettingsPanelId, readonly (keyof ChatConfig)[]>> = {
  chat: [
    'activeRunEnterBehavior',
    'stripCompact',
    'stripCompactThresholdTokens',
    'inputBufferEnabled',
    'recapEnabled',
    'imageToTextModel'
  ],
  source: ['autoMemoryDistillation']
}

function fingerprintPanel(config: SettingsConfig, panel: SettingsPanelId): string {
  const parts: unknown[] = []
  for (const key of ROOT_KEYS_BY_PANEL[panel] ?? []) {
    parts.push(config[key])
  }
  for (const key of GENERAL_KEYS_BY_PANEL[panel] ?? []) {
    parts.push(config.general?.[key])
  }
  for (const key of CHAT_KEYS_BY_PANEL[panel] ?? []) {
    parts.push(config.chat?.[key])
  }
  return JSON.stringify(parts)
}

export function panelSupportsDrafts(panel: SettingsPanelId): boolean {
  return !DRAFTLESS_PANELS.has(panel)
}

/** The panels a user would have to visit to review everything they have not saved yet. */
export function getDirtySettingsPanels(input: SettingsDirtyInput): ReadonlySet<SettingsPanelId> {
  const dirty = new Set<SettingsPanelId>()
  const { savedConfig, draftConfig } = input

  if (savedConfig && draftConfig) {
    for (const { id } of SETTINGS_PANELS) {
      if (fingerprintPanel(savedConfig, id) !== fingerprintPanel(draftConfig, id)) {
        dirty.add(id)
      }
    }
  }

  if (input.isChannelsDirty) {
    dirty.add('channels')
  }

  // USER.md and SOUL.md are edited from sub-pages of General > Behavior.
  if (input.isUserDocumentDirty || input.isSoulDocumentDirty) {
    dirty.add('general')
  }

  return dirty
}
