export type SettingsTabId =
  | 'general'
  | 'providers'
  | 'chat'
  | 'capabilities'
  | 'source'
  | 'channels'
  | 'schedules'
  | 'usage'
  | 'about'

export interface SettingsSubTab {
  id: string
  label: string
}

export interface SettingsTab {
  id: SettingsTabId
  label: string
  subTabs?: SettingsSubTab[]
}

export interface SettingsRoute {
  tab: SettingsTabId
  subTab?: string
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  {
    id: 'general',
    label: 'General',
    subTabs: [
      { id: 'general', label: 'General' },
      { id: 'ui', label: 'User Interface' }
    ]
  },
  { id: 'providers', label: 'Providers' },
  {
    id: 'chat',
    label: 'Chat',
    subTabs: [
      { id: 'threads', label: 'Threads' },
      { id: 'essentials', label: 'Essentials' }
    ]
  },
  {
    id: 'capabilities',
    label: 'Capabilities',
    subTabs: [
      { id: 'skills', label: 'Skills' },
      { id: 'coding-agents', label: 'Coding' },
      { id: 'prompts', label: 'Prompts' },
      { id: 'workspace', label: 'Workspace' }
    ]
  },
  {
    id: 'source',
    label: 'Sources',
    subTabs: [
      { id: 'memory', label: 'Memory' },
      { id: 'search', label: 'Search' },
      { id: 'activity', label: 'Activity' }
    ]
  },
  {
    id: 'channels',
    label: 'Channels',
    subTabs: [
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
    subTabs: [
      { id: 'list', label: 'Schedules' },
      { id: 'history', label: 'History' }
    ]
  },
  {
    id: 'usage',
    label: 'Statistics',
    subTabs: [
      { id: 'usage', label: 'Usage' },
      { id: 'performance', label: 'Performance' }
    ]
  },
  { id: 'about', label: 'About' }
]

const topLevelRoutes = new Set<string>(SETTINGS_TABS.map((tab) => tab.id))
const tabsById = new Map(SETTINGS_TABS.map((tab) => [tab.id, tab]))
const routeAliases: Record<string, SettingsRoute> = {
  ui: { tab: 'general', subTab: 'ui' },
  essentials: { tab: 'chat', subTab: 'essentials' },
  skills: { tab: 'capabilities', subTab: 'skills' },
  'coding-agents': { tab: 'capabilities', subTab: 'coding-agents' },
  prompts: { tab: 'capabilities', subTab: 'prompts' },
  workspace: { tab: 'capabilities', subTab: 'workspace' },
  memory: { tab: 'source', subTab: 'memory' },
  search: { tab: 'source', subTab: 'search' },
  activity: { tab: 'source', subTab: 'activity' }
}

export function getInitialSettingsSubTabs(): Record<string, string> {
  const map: Record<string, string> = {}
  for (const tab of SETTINGS_TABS) {
    if (tab.subTabs?.length) {
      map[tab.id] = tab.subTabs[0].id
    }
  }
  return map
}

export function resolveSettingsRoute(value: string): SettingsRoute {
  if (value in routeAliases) {
    return routeAliases[value]
  }

  const [tabId, subTabId] = value.split('/')
  const tab = tabsById.get(tabId as SettingsTabId)
  if (tab && subTabId && tab.subTabs?.some((subTab) => subTab.id === subTabId)) {
    return { tab: tab.id, subTab: subTabId }
  }

  if (topLevelRoutes.has(value)) {
    return { tab: value as SettingsTabId }
  }

  return { tab: 'general' }
}
