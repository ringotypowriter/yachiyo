import { t } from '@yachiyo/i18n/index'

export type AppTabId = 'chat' | 'things' | 'archived' | 'settings'
export type AppSidebarMode = 'chat' | 'archived'

export interface AppTabDefinition {
  id: AppTabId
}

export type AppTabBarBottomToolId = 'update' | 'more'

export const APP_TOP_BAR_HEIGHT = 48
// Top inset of the floating content card; the card's header height subtracts
// this so its bottom divider stays level with the sidebar chrome divider.
export const APP_CONTENT_CARD_TOP_INSET = 8
export const APP_TAB_BAR_WIDTH = 56
export const APP_TRAFFIC_LIGHT_SAFE_WIDTH = 84
export const APP_TAB_FRAME_TRAFFIC_LIGHT_SAFE_WIDTH =
  APP_TRAFFIC_LIGHT_SAFE_WIDTH - APP_TAB_BAR_WIDTH

export const APP_TABS: readonly AppTabDefinition[] = [
  { id: 'chat' },
  { id: 'things' },
  { id: 'archived' },
  { id: 'settings' }
]

// Called at render time (never cached) — the component reading this must
// call useT()/useLocale() so it re-renders when the locale changes.
export function appTabLabel(id: AppTabId): string {
  switch (id) {
    case 'chat':
      return t('layout.tabs.work')
    case 'things':
      return t('layout.tabs.things')
    case 'archived':
      return t('layout.tabs.archived')
    case 'settings':
      return t('layout.tabs.settings')
  }
}

export function appTabForThreadListMode(mode: 'active' | 'archived'): AppTabId {
  return mode === 'archived' ? 'archived' : 'chat'
}

export function threadListModeForAppTab(tab: AppTabId): 'active' | 'archived' | null {
  if (tab === 'chat') return 'active'
  if (tab === 'archived') return 'archived'
  return null
}

export function shouldRenderWorkTabFrame(tab: AppTabId): boolean {
  return tab === 'chat' || tab === 'things' || tab === 'archived'
}

export function sidebarModeForAppTab(tab: AppTabId): AppSidebarMode | null {
  if (tab === 'archived') return 'archived'
  if (tab === 'chat' || tab === 'things') return 'chat'
  return null
}

export function shouldActivateThreadsFromSidebar(tab: AppTabId): boolean {
  return tab === 'chat' || tab === 'archived'
}

export function shouldSelectThreadsFromSidebar(tab: AppTabId): boolean {
  return tab === 'chat' || tab === 'things' || tab === 'archived'
}

export function resolveAppTabBarBottomTools(
  updateAvailable: boolean
): readonly AppTabBarBottomToolId[] {
  return updateAvailable ? ['update', 'more'] : ['more']
}

export function resolveAppTabFrameSidebarDividerOffset(
  sidebarDividerOffset: number | null
): number | null {
  return sidebarDividerOffset
}

export function shouldShowAppTabFrameSidebarTopControls(isSidebarOpen: boolean): boolean {
  return isSidebarOpen
}

export function resolveAppTabFrameTopChromeColumn(isSidebarOpen: boolean): string {
  return isSidebarOpen ? '1 / 2' : '1 / 3'
}
