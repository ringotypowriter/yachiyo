export type AppTabId = 'chat' | 'archived' | 'settings'

export interface AppTabDefinition {
  id: AppTabId
  label: string
}

export type AppTabBarBottomToolId = 'update' | 'more'

export const APP_TOP_BAR_HEIGHT = 48
export const APP_TAB_BAR_WIDTH = 56
export const APP_TRAFFIC_LIGHT_SAFE_WIDTH = 84

export const APP_TABS: readonly AppTabDefinition[] = [
  { id: 'chat', label: 'Work' },
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

export function resolveAppTabFrameSidebarDividerOffset(
  sidebarDividerOffset: number | null
): number | null {
  return sidebarDividerOffset === null ? null : APP_TAB_BAR_WIDTH + sidebarDividerOffset
}

export function shouldShowAppTabFrameSidebarTopControls(isSidebarOpen: boolean): boolean {
  return isSidebarOpen
}

export function resolveAppTabFrameTopChromeColumn(isSidebarOpen: boolean): string {
  return isSidebarOpen ? '1 / 3' : '1 / 4'
}
