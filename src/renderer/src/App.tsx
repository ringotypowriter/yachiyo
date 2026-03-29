import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import avatarUrl from '../../../resources/branding.jpeg'
import { AppMainPanel } from '@renderer/features/layout/components/AppMainPanel'
import { AppSidebar } from '@renderer/features/layout/components/AppSidebar'
import { AppSidebarDivider } from '@renderer/features/layout/components/AppSidebarDivider'
import { useSidebarVisibilityState } from '@renderer/features/layout/hooks/useSidebarVisibilityState'
import { isCreateNewThreadShortcut } from '@renderer/features/layout/lib/newThreadShortcut'
import { isOpenSidebarSearchShortcut } from '@renderer/features/layout/lib/findBarShortcut'
import { ToastPresenter } from '@renderer/features/notifications/components/ToastPresenter'

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
        background: 'rgba(255, 255, 255, 0.60)',
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
          boxShadow: '0 0 0 1px rgba(0,0,0,0.06), 0 4px 24px rgba(0,0,0,0.12)'
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
            color: 'rgba(28,28,30,0.85)',
            letterSpacing: '-0.2px'
          }}
        >
          {status === 'connecting' ? 'Starting up…' : 'Unable to connect'}
        </span>
        <span style={{ fontSize: 12, color: 'rgba(28,28,30,0.40)' }}>
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
  const createNewThread = useAppStore((s) => s.createNewThread)
  const setActiveArchivedThread = useAppStore((s) => s.setActiveArchivedThread)
  const [isSidebarSearchOpen, setIsSidebarSearchOpen] = useState(false)

  useEffect(() => {
    return window.api.onNavigateToArchivedThread((threadId) => {
      setActiveArchivedThread(threadId)
    })
  }, [setActiveArchivedThread])
  const [pendingFindQuery, setPendingFindQuery] = useState<string | null>(null)

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!isCreateNewThreadShortcut(event)) {
        return
      }

      event.preventDefault()
      void createNewThread()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [createNewThread])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (!isOpenSidebarSearchShortcut(e)) return
      e.preventDefault()
      setIsSidebarSearchOpen(true)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

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

  return (
    <div
      className="flex h-full overflow-hidden relative"
      style={{ userSelect: isDragging ? 'none' : undefined }}
    >
      <AppSidebar
        isDragging={isDragging}
        isOpen={isSidebarOpen}
        isToggleDisabled={!isConfigLoaded}
        onToggle={() => void toggleSidebar()}
        sidebarWidth={sidebarLayout.sidebarWidth}
        toggleTitle={sidebarLayout.toggleTitle}
        isSearchOpen={isSidebarSearchOpen}
        onOpenSearch={() => setIsSidebarSearchOpen(true)}
        onCloseSearch={() => setIsSidebarSearchOpen(false)}
        onSearchSelect={(query) => setPendingFindQuery(query)}
      />
      <AppSidebarDivider offset={sidebarLayout.dividerOffset} onDragStart={onDragStart} />
      <div
        className="flex flex-1 min-w-0"
        style={{
          padding: isSidebarOpen ? '8px 8px 8px 4px' : '0',
          transition: 'padding 200ms ease'
        }}
      >
        <AppMainPanel
          headerPaddingLeft={sidebarLayout.mainHeaderPaddingLeft}
          isSidebarOpen={isSidebarOpen}
          isSidebarToggleDisabled={!isConfigLoaded}
          showSidebarToggle={!isSidebarOpen}
          onToggleSidebar={() => void openSidebar()}
          toggleSidebarTitle={sidebarLayout.toggleTitle}
          pendingFindQuery={pendingFindQuery}
          onPendingFindQueryApplied={() => setPendingFindQuery(null)}
        />
      </div>
      <ToastPresenter />

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
