import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import avatarUrl from '../../../resources/branding.jpeg'
import SettingsPanel, { SettingsSidebarContent } from '../settings/App'
import { AppMainPanel } from '@renderer/features/layout/components/AppMainPanel'
import {
  AppSidebarContent,
  AppSidebarTopControls
} from '@renderer/features/layout/components/AppSidebar'
import { AppTabFrame } from '@renderer/features/layout/components/AppTabFrame'
import { useSidebarVisibilityState } from '@renderer/features/layout/hooks/useSidebarVisibilityState'
import { isCreateNewThreadShortcut } from '@renderer/features/layout/lib/newThreadShortcut'
import { isOpenSidebarSearchShortcut } from '@renderer/features/layout/lib/findBarShortcut'
import {
  appTabForThreadListMode,
  resolveAppTabFrameSidebarDividerOffset,
  threadListModeForAppTab,
  type AppTabId
} from '@renderer/features/layout/lib/appTabs'
import { shouldHandleWorkShortcut } from '@renderer/features/layout/lib/workShortcutScope'
import { ToastPresenter } from '@renderer/features/notifications/components/ToastPresenter'
import { GlobalProcessingModal } from '@renderer/components/GlobalProcessingModal'
import { alpha, theme } from '@renderer/theme/theme'
import { useApplyThemeConfig } from '@renderer/theme/useThemeConfig'

function ConnectionOverlay({
  status,
  exiting
}: {
  status: 'connecting' | 'disconnected'
  exiting: boolean
}): React.JSX.Element {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        backdropFilter: 'blur(24px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
        background: theme.background.surfaceLight,
        opacity: exiting ? 0 : 1,
        transform: exiting ? 'translateY(-16px)' : 'translateY(0)',
        transition: exiting ? 'opacity 380ms ease, transform 380ms ease' : 'none',
        pointerEvents: exiting ? 'none' : undefined
      }}
    >
      <div
        style={{
          width: 96,
          height: 96,
          borderRadius: '50%',
          overflow: 'hidden',
          boxShadow: theme.shadow.overlay
        }}
      >
        <img
          src={avatarUrl}
          alt="Yachiyo"
          style={{
            display: 'block',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'center 15%'
          }}
        />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
        <span
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: theme.text.primary,
            letterSpacing: '-0.2px'
          }}
        >
          {status === 'connecting' ? 'Starting up…' : 'Unable to connect'}
        </span>
        <span style={{ fontSize: 12, color: theme.text.muted }}>
          {status === 'connecting' ? 'Yachiyo is waking up' : 'Waiting for the local server'}
        </span>
      </div>
    </div>
  )
}

function App(): React.JSX.Element {
  const {
    isDragging,
    isConfigLoaded,
    isSidebarOpen,
    onDragStart,
    openSidebar,
    sidebarLayout,
    toggleSidebar
  } = useSidebarVisibilityState()
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const [overlayMounted, setOverlayMounted] = useState(() => connectionStatus !== 'connected')
  const [overlayExiting, setOverlayExiting] = useState(false)
  const overlayShownAtRef = useRef<number>(0)

  useEffect(() => {
    if (connectionStatus !== 'connected') {
      overlayShownAtRef.current = Date.now()
      const t = setTimeout(() => {
        setOverlayMounted(true)
        setOverlayExiting(false)
      }, 0)
      return () => clearTimeout(t)
    }

    const elapsed = Date.now() - overlayShownAtRef.current
    const delay = Math.max(0, 2000 - elapsed)
    let removeTimer: ReturnType<typeof setTimeout> | null = null

    const exitTimer = setTimeout(() => {
      setOverlayExiting(true)
      removeTimer = setTimeout(() => {
        setOverlayMounted(false)
        setOverlayExiting(false)
      }, 400)
    }, delay)

    return () => {
      clearTimeout(exitTimer)
      if (removeTimer !== null) clearTimeout(removeTimer)
    }
  }, [connectionStatus])
  const config = useAppStore((s) => s.config)
  useApplyThemeConfig(config)
  const createNewThread = useAppStore((s) => s.createNewThread)
  const openThreadFromNotification = useAppStore((s) => s.openThreadFromNotification)
  const setThreadListMode = useAppStore((s) => s.setThreadListMode)
  const threadListMode = useAppStore((s) => s.threadListMode)
  const [settingsTabActive, setSettingsTabActive] = useState(false)
  const [settingsRoute, setSettingsRoute] = useState('general')
  const [hasOpenedSettings, setHasOpenedSettings] = useState(false)
  const [isSidebarSearchOpen, setIsSidebarSearchOpen] = useState(false)
  const activeAppTab: AppTabId = settingsTabActive
    ? 'settings'
    : appTabForThreadListMode(threadListMode)

  const handleSelectAppTab = useCallback(
    (tab: AppTabId): void => {
      if (tab === 'settings') {
        setHasOpenedSettings(true)
        setSettingsTabActive(true)
        void openSidebar()
        return
      }

      setSettingsTabActive(false)
      if (tab === 'archived') {
        setIsSidebarSearchOpen(false)
      }

      const mode = threadListModeForAppTab(tab)
      if (mode) setThreadListMode(mode)
    },
    [openSidebar, setThreadListMode]
  )

  const handleOpenSettingsRoute = useCallback(
    (route = 'general'): void => {
      setSettingsRoute(route)
      setHasOpenedSettings(true)
      setSettingsTabActive(true)
      void openSidebar()
    },
    [openSidebar]
  )

  useEffect(() => {
    const unsubscribeThread = window.api.onNavigateToThread((threadId) => {
      setSettingsTabActive(false)
      openThreadFromNotification(threadId)
    })
    const unsubscribeArchivedThread = window.api.onNavigateToArchivedThread((threadId) => {
      setSettingsTabActive(false)
      openThreadFromNotification(threadId, 'archivedThread')
    })
    return () => {
      unsubscribeThread()
      unsubscribeArchivedThread()
    }
  }, [openThreadFromNotification])

  useEffect(() => {
    return window.api.onNavigateSettingsTo((route) => {
      handleOpenSettingsRoute(route)
    })
  }, [handleOpenSettingsRoute])
  const [pendingFindQuery, setPendingFindQuery] = useState<string | null>(null)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!shouldHandleWorkShortcut(activeAppTab)) {
        return
      }

      if (!isCreateNewThreadShortcut(event)) {
        return
      }

      event.preventDefault()
      void createNewThread()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [activeAppTab, createNewThread])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!shouldHandleWorkShortcut(activeAppTab)) return
      if (!isOpenSidebarSearchShortcut(e)) return
      e.preventDefault()
      setIsSidebarSearchOpen(true)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [activeAppTab])

  useEffect(() => {
    if (isSidebarOpen) {
      window.api.setVibrancy(true)
      return
    }
    const timer = setTimeout(() => window.api.setVibrancy(false), 220)
    return () => clearTimeout(timer)
  }, [isSidebarOpen])

  useEffect(() => {
    const flushOnReturn = (): void => {
      if (!document.hidden) {
        useAppStore.getState().flushQueuedToasts()
      }
    }
    window.addEventListener('focus', flushOnReturn)
    document.addEventListener('visibilitychange', flushOnReturn)
    return () => {
      window.removeEventListener('focus', flushOnReturn)
      document.removeEventListener('visibilitychange', flushOnReturn)
    }
  }, [])

  useEffect(() => {
    const uiFontSize = config?.general?.uiFontSize
    const chatFontSize = config?.general?.chatFontSize
    if (uiFontSize != null) {
      document.documentElement.style.setProperty('--yachiyo-ui-zoom', String(uiFontSize / 14))
    } else {
      document.documentElement.style.removeProperty('--yachiyo-ui-zoom')
    }
    if (chatFontSize != null) {
      document.documentElement.style.setProperty('--yachiyo-font-size-chat', `${chatFontSize}px`)
    } else {
      document.documentElement.style.removeProperty('--yachiyo-font-size-chat')
    }
  }, [config?.general?.uiFontSize, config?.general?.chatFontSize])

  const windowBackdrop = `linear-gradient(90deg, ${alpha('sidebar', 0.15)} 0%, ${theme.background.surfaceLight} 100%)`
  const isSettingsTabActive = activeAppTab === 'settings'
  const threadSidebarMode = threadListMode === 'archived' ? 'archived' : 'chat'
  const sidebarDividerOffset = resolveAppTabFrameSidebarDividerOffset(sidebarLayout.dividerOffset)
  const mainHeaderPaddingLeft = isSidebarOpen ? sidebarLayout.mainHeaderPaddingLeft : 20
  const renderTabFrame = ({
    content,
    contentSubControls,
    contentTopControls,
    sidebar,
    sidebarTopControls,
    visible
  }: {
    content: ReactNode
    contentSubControls?: ReactNode
    contentTopControls: ReactNode
    sidebar: ReactNode
    sidebarTopControls: ReactNode
    visible: boolean
  }): React.JSX.Element => (
    <AppTabFrame
      activeTab={activeAppTab}
      content={content}
      contentSubControls={contentSubControls}
      contentTopControls={contentTopControls}
      isDragging={isDragging}
      isSidebarOpen={isSidebarOpen}
      onOpenSettingsRoute={handleOpenSettingsRoute}
      onSelectTab={handleSelectAppTab}
      onSidebarDragStart={onDragStart}
      sidebar={sidebar}
      sidebarDividerOffset={sidebarDividerOffset}
      sidebarTopControls={sidebarTopControls}
      sidebarWidth={sidebarLayout.sidebarWidth}
      visible={visible}
    />
  )

  return (
    <div
      className="flex h-full overflow-hidden relative"
      style={{
        background: windowBackdrop,
        userSelect: isDragging ? 'none' : undefined
      }}
    >
      <AppMainPanel
        headerPaddingLeft={mainHeaderPaddingLeft}
        isSidebarToggleDisabled={!isConfigLoaded}
        showSidebarToggle={!isSidebarOpen}
        onToggleSidebar={() => void openSidebar()}
        toggleSidebarTitle={sidebarLayout.toggleTitle}
        pendingFindQuery={pendingFindQuery}
        onPendingFindQueryApplied={() => setPendingFindQuery(null)}
        shortcutsEnabled={shouldHandleWorkShortcut(activeAppTab)}
      >
        {(slots) =>
          renderTabFrame({
            content: slots.content,
            contentTopControls: slots.contentTopControls,
            sidebar: (
              <AppSidebarContent
                mode={threadSidebarMode}
                isSearchOpen={isSidebarSearchOpen}
                onCloseSearch={() => setIsSidebarSearchOpen(false)}
                onSearchSelect={(query) => setPendingFindQuery(query)}
              />
            ),
            sidebarTopControls: (
              <AppSidebarTopControls
                mode={threadSidebarMode}
                isSearchOpen={isSidebarSearchOpen}
                isToggleDisabled={!isConfigLoaded}
                onOpenSearch={() => setIsSidebarSearchOpen(true)}
                onToggle={() => void toggleSidebar()}
                toggleTitle={sidebarLayout.toggleTitle}
              />
            ),
            visible: !isSettingsTabActive
          })
        }
      </AppMainPanel>

      {(hasOpenedSettings || isSettingsTabActive) && (
        <SettingsPanel
          active={isSettingsTabActive}
          route={settingsRoute}
          onRouteChange={setSettingsRoute}
        >
          {(slots) =>
            renderTabFrame({
              content: slots.content,
              contentSubControls: slots.contentSubControls,
              contentTopControls: slots.contentTopControls,
              sidebar: (
                <SettingsSidebarContent route={settingsRoute} onRouteChange={setSettingsRoute} />
              ),
              sidebarTopControls: null,
              visible: isSettingsTabActive
            })
          }
        </SettingsPanel>
      )}
      <ToastPresenter />
      <GlobalProcessingModal />

      {overlayMounted && (
        <ConnectionOverlay
          status={connectionStatus === 'connected' ? 'connecting' : connectionStatus}
          exiting={overlayExiting}
        />
      )}
    </div>
  )
}

export default App
