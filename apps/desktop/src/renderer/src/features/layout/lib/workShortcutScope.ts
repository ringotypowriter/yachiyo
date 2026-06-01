import type { AppTabId } from './appTabs.ts'

export function shouldHandleWorkShortcut(activeTab: AppTabId): boolean {
  return activeTab === 'chat' || activeTab === 'archived'
}
