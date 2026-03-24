import { useEffect, useState } from 'react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { AppMainPanel } from '@renderer/features/layout/components/AppMainPanel'
import { AppSidebar } from '@renderer/features/layout/components/AppSidebar'
import { AppSidebarDivider } from '@renderer/features/layout/components/AppSidebarDivider'
import { useSidebarVisibilityState } from '@renderer/features/layout/hooks/useSidebarVisibilityState'
import { isCreateNewThreadShortcut } from '@renderer/features/layout/lib/newThreadShortcut'
import { isOpenSidebarSearchShortcut } from '@renderer/features/layout/lib/findBarShortcut'

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
    const uiFontSize = config?.general?.uiFontSize
    const chatFontSize = config?.general?.chatFontSize
    if (uiFontSize != null) {
      document.documentElement.style.setProperty('--yachiyo-font-size-ui', `${uiFontSize}px`)
    } else {
      document.documentElement.style.removeProperty('--yachiyo-font-size-ui')
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
      <div className="flex flex-1 min-w-0 p-2 pl-1">
        <AppMainPanel
          headerPaddingLeft={sidebarLayout.mainHeaderPaddingLeft}
          isSidebarToggleDisabled={!isConfigLoaded}
          showSidebarToggle={!isSidebarOpen}
          onToggleSidebar={() => void openSidebar()}
          toggleSidebarTitle={sidebarLayout.toggleTitle}
          pendingFindQuery={pendingFindQuery}
          onPendingFindQueryApplied={() => setPendingFindQuery(null)}
        />
      </div>
    </div>
  )
}

export default App
