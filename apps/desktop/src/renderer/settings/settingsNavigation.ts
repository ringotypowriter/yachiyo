import { t, type AppCatalog } from '@yachiyo/i18n/index'

export type SettingsPanelId =
  | 'general'
  | 'providers'
  | 'chat'
  | 'capabilities'
  | 'source'
  | 'channels'
  | 'schedules'
  | 'sync'
  | 'usage'
  | 'about'

export interface SettingsPanelTab {
  id: string
  label: string
}

export interface SettingsPanelDefinition {
  id: SettingsPanelId
  label: string
  tabs?: readonly SettingsPanelTab[]
}

export interface SettingsRoute {
  panel: SettingsPanelId
  tab?: string
}

type SettingsNavLabelKey = keyof AppCatalog['settings']['nav'] & string

function localizedTab(id: string, labelKey: SettingsNavLabelKey): SettingsPanelTab {
  return {
    id,
    get label(): string {
      return t(`settings.nav.${labelKey}`)
    }
  }
}

function localizedPanel(
  id: SettingsPanelId,
  labelKey: SettingsNavLabelKey,
  tabs?: readonly SettingsPanelTab[]
): SettingsPanelDefinition {
  return {
    id,
    get label(): string {
      return t(`settings.nav.${labelKey}`)
    },
    tabs
  }
}

export const SETTINGS_PANELS: readonly SettingsPanelDefinition[] = [
  localizedPanel('general', 'general', [
    localizedTab('behavior', 'behavior'),
    localizedTab('ui', 'ui')
  ]),
  localizedPanel('providers', 'providers'),
  localizedPanel('chat', 'chat', [
    localizedTab('threads', 'threads'),
    localizedTab('essentials', 'essentials')
  ]),
  localizedPanel('capabilities', 'capabilities', [
    localizedTab('skills', 'skills'),
    localizedTab('coding-agents', 'coding'),
    localizedTab('prompts', 'prompts'),
    localizedTab('workspace', 'workspace')
  ]),
  localizedPanel('source', 'sources', [
    localizedTab('memory', 'memory'),
    localizedTab('search', 'search'),
    localizedTab('activity', 'activity')
  ]),
  localizedPanel('channels', 'channels', [
    localizedTab('general', 'general'),
    localizedTab('telegram', 'telegram'),
    localizedTab('qq', 'qq'),
    localizedTab('qqbot', 'qqbot'),
    localizedTab('discord', 'discord')
  ]),
  localizedPanel('schedules', 'schedules', [
    localizedTab('list', 'schedules'),
    localizedTab('history', 'history')
  ]),
  localizedPanel('sync', 'sync'),
  localizedPanel('usage', 'statistics', [
    localizedTab('usage', 'usage'),
    localizedTab('performance', 'performance')
  ]),
  localizedPanel('about', 'about')
]

const topLevelRoutes = new Set<string>(SETTINGS_PANELS.map((panel) => panel.id))
const panelsById = new Map(SETTINGS_PANELS.map((panel) => [panel.id, panel]))
const routeAliases: Record<string, SettingsRoute> = {
  behavior: { panel: 'general', tab: 'behavior' },
  ui: { panel: 'general', tab: 'ui' },
  essentials: { panel: 'chat', tab: 'essentials' },
  skills: { panel: 'capabilities', tab: 'skills' },
  'coding-agents': { panel: 'capabilities', tab: 'coding-agents' },
  prompts: { panel: 'capabilities', tab: 'prompts' },
  workspace: { panel: 'capabilities', tab: 'workspace' },
  memory: { panel: 'source', tab: 'memory' },
  search: { panel: 'source', tab: 'search' },
  activity: { panel: 'source', tab: 'activity' }
}

const panelTabAliases: Partial<Record<SettingsPanelId, Record<string, string>>> = {
  general: { general: 'behavior' }
}

export function getInitialSettingsPanelTabs(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const panel of SETTINGS_PANELS) {
    if (panel.tabs?.length) {
      map[panel.id] = panel.tabs[0].id
    }
  }
  return map
}

export function serializeSettingsRoute(panel: SettingsPanelId, tab?: string): string {
  return tab ? `${panel}/${tab}` : panel
}

export function resolveSettingsRoute(value: string): SettingsRoute {
  if (value in routeAliases) {
    return routeAliases[value]
  }

  const [panelId, rawTabId] = value.split('/')
  const panel = panelsById.get(panelId as SettingsPanelId)
  if (panel && rawTabId) {
    const tabId = panelTabAliases[panel.id]?.[rawTabId] ?? rawTabId
    if (panel.tabs?.some((tab) => tab.id === tabId)) {
      return { panel: panel.id, tab: tabId }
    }
  }

  if (topLevelRoutes.has(value)) {
    return { panel: value as SettingsPanelId }
  }

  return { panel: 'general' }
}
