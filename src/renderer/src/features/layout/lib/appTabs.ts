export type AppTabId = 'chat' | 'archived' | 'settings'

export interface AppTabDefinition {
  id: AppTabId
  label: string
}

export type AppTabBarBottomToolId = 'update' | 'more'

export const APP_TAB_BAR_WIDTH = 80

export const APP_TABS: readonly AppTabDefinition[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'archived', label: 'Archived' },
  { id: 'settings', label: 'Settings' }
]

export function appTabForThreadListMode(mode: 'active' | 'archived'): AppTabId {
  return mode === 'archived' ? 'archived' : 'chat'
}

export function threadListModeForAppTab(tab: AppTabId): 'active' | 'archived' | null {
  if (tab === 'chat') return 'active'
  if (tab === 'archived') return 'archived'
  return null
}

export function resolveAppTabBarBottomTools(
  updateAvailable: boolean
): readonly AppTabBarBottomToolId[] {
  return updateAvailable ? ['update', 'more'] : ['more']
}
