import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Archive,
  ArrowDownCircle,
  MoreHorizontal,
  Hash,
  Waypoints,
  Settings2,
  type LucideIcon
} from 'lucide-react'
import { useT } from '@yachiyo/i18n/react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { Tooltip } from '@renderer/components/Tooltip'
import { SidebarUtilityMenu } from '@renderer/features/layout/components/SidebarUtilityMenu'
import {
  APP_TOP_BAR_HEIGHT,
  APP_TAB_BAR_WIDTH,
  APP_TABS,
  appTabLabel,
  resolveAppTabBarBottomTools,
  type AppTabBarBottomToolId,
  type AppTabId
} from '@renderer/features/layout/lib/appTabs'
import { alpha, theme } from '@renderer/theme/theme'

export interface AppTabBarProps {
  activeTab: AppTabId
  onOpenSettingsRoute: (route?: string) => void
  onSelectTab: (tab: AppTabId) => void
}

const appTabRailSurfaceStyle = {
  background: theme.background.sidebarVibrancy
}

const appTabRailBodyStyle = {
  ...appTabRailSurfaceStyle,
  borderRight: `1px solid ${theme.border.panel}`
}

const TAB_ICONS: Record<AppTabId, LucideIcon> = {
  chat: Waypoints,
  things: Hash,
  archived: Archive,
  settings: Settings2
}

export function AppTabRail(props: AppTabBarProps): React.JSX.Element {
  return (
    <div
      className="grid h-full shrink-0 overflow-hidden"
      style={{
        width: APP_TAB_BAR_WIDTH,
        gridTemplateRows: `${APP_TOP_BAR_HEIGHT}px minmax(0, 1fr)`
      }}
    >
      <div
        className="drag-region"
        style={{
          ...appTabRailSurfaceStyle,
          borderBottom: `1px solid ${theme.border.panel}`
        }}
      />
      <AppTabBar {...props} />
    </div>
  )
}

export function AppTabBar({
  activeTab,
  onOpenSettingsRoute,
  onSelectTab
}: AppTabBarProps): React.JSX.Element {
  const t = useT()
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [updateVersion, setUpdateVersion] = useState<string>()
  const [utilityMenuAnchor, setUtilityMenuAnchor] = useState<DOMRect | null>(null)
  const utilityMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const unreadArchivedCount = useAppStore(
    (s) => s.archivedThreads.filter((thread) => thread.archivedAt && !thread.readAt).length
  )
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const showExternalThreads = useAppStore((s) => s.showExternalThreads)
  const toggleShowExternalThreads = useAppStore((s) => s.toggleShowExternalThreads)
  const bottomTools = useMemo<AppTabBarBottomToolId[]>(
    () => [...resolveAppTabBarBottomTools(updateAvailable)],
    [updateAvailable]
  )

  useEffect(() => {
    window.api.appUpdate.getStatus().then((status) => {
      setUpdateAvailable(status.state === 'available' || status.state === 'ready')
      if (status.version) setUpdateVersion(status.version)
    })
    return window.api.appUpdate.onStatus((status) => {
      setUpdateAvailable(status.state === 'available' || status.state === 'ready')
      if (status.version) setUpdateVersion(status.version)
    })
  }, [])

  const handleOpenTranslator = useCallback(() => {
    window.api.openTranslator()
  }, [])

  const handleOpenJotdown = useCallback(() => {
    window.api.openJotdown()
  }, [])

  return (
    <div
      className="flex h-full shrink-0 flex-col overflow-hidden"
      style={{
        width: APP_TAB_BAR_WIDTH,
        ...appTabRailBodyStyle
      }}
    >
      <div
        className="flex min-h-0 flex-1 flex-col items-center overflow-hidden"
        style={{
          paddingBottom: 12
        }}
      >
        <nav
          className="no-drag flex flex-col items-center gap-2"
          style={{ paddingTop: 10 }}
          aria-label={t('layout.tabBar.appSections')}
        >
          {APP_TABS.map((tab) => {
            const Icon = TAB_ICONS[tab.id]
            const active = activeTab === tab.id
            const label = appTabLabel(tab.id)
            const archivedBadge =
              tab.id === 'archived' ? (unreadArchivedCount > 0 ? unreadArchivedCount : null) : null

            return (
              <button
                key={tab.id}
                type="button"
                aria-label={label}
                aria-pressed={active}
                onClick={() => {
                  setUtilityMenuAnchor(null)
                  onSelectTab(tab.id)
                }}
                className="relative flex flex-col items-center justify-center rounded-2xl transition-all"
                style={{
                  width: 46,
                  height: 50,
                  gap: 2,
                  color: active ? theme.text.accentStrong : theme.icon.default,
                  background: 'transparent',
                  opacity: active ? 1 : 0.6
                }}
              >
                <Icon size={18} strokeWidth={1.7} />
                <span
                  className="text-[9px] font-medium"
                  style={{
                    maxWidth: 48,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {label}
                </span>
                {archivedBadge !== null && (
                  <span
                    className="absolute -right-1 -top-0.5 flex items-center justify-center rounded-full text-[9px] font-semibold"
                    style={{
                      minWidth: 16,
                      height: 16,
                      padding: '0 4px',
                      color: unreadArchivedCount > 0 ? theme.text.inverse : theme.text.counter,
                      background:
                        unreadArchivedCount > 0
                          ? theme.text.accent
                          : theme.background.counterSurface,
                      border: `1px solid ${theme.background.surfaceFrosted}`
                    }}
                  >
                    {archivedBadge > 99 ? '99+' : archivedBadge}
                  </span>
                )}
              </button>
            )
          })}
        </nav>

        <div className="no-drag mt-auto flex flex-col items-center gap-2">
          {bottomTools.map((tool) =>
            tool === 'update' ? (
              <Tooltip
                key={tool}
                content={
                  updateVersion
                    ? t('layout.tabBar.versionAvailable', { version: updateVersion })
                    : t('layout.tabBar.updateAvailable')
                }
                placement="top"
              >
                <button
                  type="button"
                  onClick={() => {
                    setUtilityMenuAnchor(null)
                    onOpenSettingsRoute('about')
                  }}
                  className="flex flex-col items-center justify-center rounded-2xl text-[9px] font-semibold leading-none transition-opacity hover:opacity-90"
                  style={{
                    width: 46,
                    height: 42,
                    gap: 2,
                    color: theme.text.counter,
                    background: alpha('counter', 0.12)
                  }}
                  aria-label={t('layout.tabBar.installUpdate')}
                >
                  <ArrowDownCircle size={14} strokeWidth={2} />
                  <span>{t('layout.tabBar.update')}</span>
                </button>
              </Tooltip>
            ) : (
              <button
                ref={utilityMenuTriggerRef}
                key={tool}
                type="button"
                onClick={(event) => {
                  if (utilityMenuAnchor) {
                    setUtilityMenuAnchor(null)
                  } else {
                    setUtilityMenuAnchor(event.currentTarget.getBoundingClientRect())
                  }
                }}
                className="flex flex-col items-center justify-center rounded-2xl transition-opacity"
                style={{
                  width: 46,
                  height: 42,
                  gap: 2,
                  color: utilityMenuAnchor ? theme.text.accentStrong : theme.icon.default,
                  background: utilityMenuAnchor ? theme.background.hoverStrong : 'transparent',
                  opacity: utilityMenuAnchor ? 0.9 : 0.55
                }}
                aria-label={t('layout.tabBar.moreOptions')}
                aria-pressed={utilityMenuAnchor !== null}
              >
                <MoreHorizontal size={17} strokeWidth={1.6} />
                <span
                  className="text-[9px] font-medium"
                  style={{
                    maxWidth: 48,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {t('layout.tabBar.more')}
                </span>
              </button>
            )
          )}
        </div>
      </div>

      {utilityMenuAnchor && (
        <SidebarUtilityMenu
          anchorRect={utilityMenuAnchor}
          referenceRef={utilityMenuTriggerRef}
          connectionStatus={connectionStatus}
          showExternalThreads={showExternalThreads}
          onToggleExternalThreads={toggleShowExternalThreads}
          onOpenTranslator={handleOpenTranslator}
          onOpenJotdown={handleOpenJotdown}
          onClose={() => setUtilityMenuAnchor(null)}
        />
      )}
    </div>
  )
}
