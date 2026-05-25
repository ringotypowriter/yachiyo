export type SettingsPanelId =
  | 'general'
  | 'providers'
  | 'chat'
  | 'capabilities'
  | 'source'
  | 'channels'
  | 'schedules'
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

export const SETTINGS_PANELS: readonly SettingsPanelDefinition[] = [
  {
    id: 'general',
    label: 'General',
    tabs: [
      { id: 'behavior', label: 'Behavior' },
      { id: 'ui', label: 'User Interface' }
    ]
  },
  { id: 'providers', label: 'Providers' },
  {
    id: 'chat',
    label: 'Chat',
    tabs: [
      { id: 'threads', label: 'Threads' },
      { id: 'essentials', label: 'Essentials' }
    ]
  },
  {
    id: 'capabilities',
    label: 'Capabilities',
    tabs: [
      { id: 'skills', label: 'Skills' },
      { id: 'coding-agents', label: 'Coding' },
      { id: 'prompts', label: 'Prompts' },
      { id: 'workspace', label: 'Workspace' }
    ]
  },
  {
    id: 'source',
    label: 'Sources',
    tabs: [
      { id: 'memory', label: 'Memory' },
      { id: 'search', label: 'Search' },
      { id: 'activity', label: 'Activity' }
    ]
  },
  {
    id: 'channels',
    label: 'Channels',
    tabs: [
      { id: 'general', label: 'General' },
      { id: 'telegram', label: 'Telegram' },
      { id: 'qq', label: 'QQ' },
      { id: 'qqbot', label: 'QQBot' },
      { id: 'discord', label: 'Discord' }
    ]
  },
  {
    id: 'schedules',
    label: 'Schedules',
    tabs: [
      { id: 'list', label: 'Schedules' },
      { id: 'history', label: 'History' }
    ]
  },
  {
    id: 'usage',
    label: 'Statistics',
    tabs: [
      { id: 'usage', label: 'Usage' },
      { id: 'performance', label: 'Performance' }
    ]
  },
  { id: 'about', label: 'About' }
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
