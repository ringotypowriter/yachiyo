import type { ReactNode } from 'react'
import { AppSidebarDivider } from '@renderer/features/layout/components/AppSidebarDivider'
import { AppTabBar } from '@renderer/features/layout/components/AppTabBar'
import {
  APP_TAB_BAR_WIDTH,
  APP_TOP_BAR_HEIGHT,
  APP_TRAFFIC_LIGHT_SAFE_WIDTH,
  resolveAppTabFrameTopChromeColumn,
  shouldShowAppTabFrameSidebarTopControls,
  type AppTabId
} from '@renderer/features/layout/lib/appTabs'
import { alpha, theme } from '@renderer/theme/theme'

export interface AppTabFrameProps {
  activeTab: AppTabId
  content: ReactNode
  contentSubControls?: ReactNode
  contentTopControls: ReactNode
  isDragging: boolean
  isSidebarOpen: boolean
  onOpenSettingsRoute: (route?: string) => void
  onSelectTab: (tab: AppTabId) => void
  onSidebarDragStart: (e: React.MouseEvent) => void
  sidebar: ReactNode
  sidebarDividerOffset: number | null
  sidebarTopControls: ReactNode
  sidebarWidth: number
  visible?: boolean
}

export function AppTabFrame({
  activeTab,
  content,
  contentSubControls,
  contentTopControls,
  isDragging,
  isSidebarOpen,
  onOpenSettingsRoute,
  onSelectTab,
  onSidebarDragStart,
  sidebar,
  sidebarDividerOffset,
  sidebarTopControls,
  sidebarWidth,
  visible = true
}: AppTabFrameProps): React.JSX.Element {
  const chromeBackground = alpha('sidebar', 0.15)
  const showSidebarTopControls = shouldShowAppTabFrameSidebarTopControls(isSidebarOpen)
  const topChromeColumn = resolveAppTabFrameTopChromeColumn(isSidebarOpen)

  return (
    <div
      className="h-full min-w-0 flex-1"
      style={{
        display: visible ? 'grid' : 'none',
        gridTemplateColumns: `${APP_TAB_BAR_WIDTH}px ${sidebarWidth}px minmax(0, 1fr)`,
        gridTemplateRows: `${APP_TOP_BAR_HEIGHT}px minmax(0, 1fr)`,
        position: 'relative'
      }}
    >
      {visible ? (
        <>
          <div
            className="drag-region flex min-w-0 items-center"
            style={{
              gridColumn: topChromeColumn,
              gridRow: '1',
              background: chromeBackground,
              borderBottom: `1px solid ${theme.border.panel}`
            }}
          >
            <div className="h-full shrink-0" style={{ width: APP_TRAFFIC_LIGHT_SAFE_WIDTH }} />
            {showSidebarTopControls ? (
              <div className="no-drag flex h-full min-w-0 flex-1 items-center pr-3">
                {sidebarTopControls}
              </div>
            ) : null}
          </div>
          {!isSidebarOpen ? (
            <div
              className="drag-region flex min-w-0 items-center"
              style={{
                gridColumn: '1 / 4',
                gridRow: '1',
                marginLeft: APP_TRAFFIC_LIGHT_SAFE_WIDTH,
                minWidth: 0
              }}
            >
              {contentTopControls}
            </div>
          ) : null}
          <div style={{ gridColumn: '1', gridRow: '2', minHeight: 0 }}>
            <AppTabBar
              activeTab={activeTab}
              onSelectTab={onSelectTab}
              onOpenSettingsRoute={onOpenSettingsRoute}
            />
          </div>
        </>
      ) : null}
      <aside
        aria-hidden={!isSidebarOpen}
        className="flex h-full shrink-0 flex-col overflow-hidden"
        style={{
          gridColumn: '2',
          gridRow: '2',
          background: chromeBackground,
          backdropFilter: 'blur(24px) saturate(1.4)',
          WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
          opacity: isSidebarOpen ? 1 : 0,
          pointerEvents: isSidebarOpen ? 'auto' : 'none',
          transition: isDragging ? 'none' : 'opacity 200ms, width 200ms'
        }}
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{sidebar}</div>
      </aside>

      <AppSidebarDivider offset={sidebarDividerOffset} onDragStart={onSidebarDragStart} />

      <div
        className="flex min-w-0 flex-1"
        style={{
          gridColumn: '3',
          gridRow: isSidebarOpen ? '1 / 3' : '2',
          minWidth: 0,
          minHeight: 0,
          background: `linear-gradient(90deg, ${chromeBackground} 0%, ${theme.background.surfaceLight} 100%)`,
          padding: isSidebarOpen ? '8px 8px 8px 4px' : '0',
          transition: 'padding 200ms ease'
        }}
      >
        <main
          className="flex h-full min-w-0 flex-1 flex-col overflow-hidden"
          style={{
            background: theme.background.chatCard,
            borderRadius: isSidebarOpen ? 12 : 0,
            boxShadow: isSidebarOpen ? theme.shadow.card : 'none',
            transition: 'border-radius 200ms ease, box-shadow 200ms ease'
          }}
        >
          {isSidebarOpen ? (
            <div
              className="drag-region flex shrink-0 items-center"
              style={{
                height: APP_TOP_BAR_HEIGHT,
                borderBottom: `1px solid ${theme.border.panel}`,
                position: 'relative'
              }}
            >
              {contentTopControls}
            </div>
          ) : null}
          {contentSubControls ? (
            <div className="shrink-0" style={{ borderBottom: `1px solid ${theme.border.panel}` }}>
              {contentSubControls}
            </div>
          ) : null}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{content}</div>
        </main>
      </div>
    </div>
  )
}
