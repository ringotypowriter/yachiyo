import { useEffect } from 'react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { AppMainPanel } from '@renderer/features/layout/components/AppMainPanel'
import { AppSidebar } from '@renderer/features/layout/components/AppSidebar'
import { useSidebarVisibilityState } from '@renderer/features/layout/hooks/useSidebarVisibilityState'
import { isCreateNewThreadShortcut } from '@renderer/features/layout/lib/newThreadShortcut'

function App(): React.JSX.Element {
  const { isConfigLoaded, isSidebarOpen, openSidebar, sidebarLayout, toggleSidebar } =
    useSidebarVisibilityState()
  const createNewThread = useAppStore((s) => s.createNewThread)

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

  return (
    <div className="flex h-full overflow-hidden relative">
      <AppSidebar
        isOpen={isSidebarOpen}
        isToggleDisabled={!isConfigLoaded}
        onToggle={() => void toggleSidebar()}
        sidebarWidth={sidebarLayout.sidebarWidth}
        toggleTitle={sidebarLayout.toggleTitle}
      />
      <div className="flex flex-1 min-w-0 p-2 pl-1">
        <AppMainPanel
          headerPaddingLeft={sidebarLayout.mainHeaderPaddingLeft}
          isSidebarToggleDisabled={!isConfigLoaded}
          showSidebarToggle={!isSidebarOpen}
          onToggleSidebar={() => void openSidebar()}
          toggleSidebarTitle={sidebarLayout.toggleTitle}
        />
      </div>
    </div>
  )
}

export default App
