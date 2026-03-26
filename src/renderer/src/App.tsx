import { useEffect, useState } from 'react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { AppMainPanel } from '@renderer/features/layout/components/AppMainPanel'
import { AppSidebar } from '@renderer/features/layout/components/AppSidebar'
import { AppSidebarDivider } from '@renderer/features/layout/components/AppSidebarDivider'
import { useSidebarVisibilityState } from '@renderer/features/layout/hooks/useSidebarVisibilityState'
import { isCreateNewThreadShortcut } from '@renderer/features/layout/lib/newThreadShortcut'
import { isOpenSidebarSearchShortcut } from '@renderer/features/layout/lib/findBarShortcut'
import { ToastPresenter } from '@renderer/features/notifications/components/ToastPresenter'

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
  const config = useAppStore((s) => s.config)
  const createNewThread = useAppStore((s) => s.createNewThread)
  const [isSidebarSearchOpen, setIsSidebarSearchOpen] = useState(false)
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
    </div>
  )
}

export default App
