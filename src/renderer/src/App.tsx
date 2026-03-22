import { useEffect } from 'react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { AppMainPanel } from '@renderer/features/layout/components/AppMainPanel'
import { AppSidebarDivider } from '@renderer/features/layout/components/AppSidebarDivider'
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
      <AppSidebarDivider offset={sidebarLayout.dividerOffset} />
      <AppSidebar
        isOpen={isSidebarOpen}
        isToggleDisabled={!isConfigLoaded}
        onToggle={() => void toggleSidebar()}
        sidebarWidth={sidebarLayout.sidebarWidth}
        toggleTitle={sidebarLayout.toggleTitle}
      />
      <AppMainPanel
        headerPaddingLeft={sidebarLayout.mainHeaderPaddingLeft}
        isSidebarToggleDisabled={!isConfigLoaded}
        showSidebarToggle={!isSidebarOpen}
        onToggleSidebar={() => void openSidebar()}
        toggleSidebarTitle={sidebarLayout.toggleTitle}
      />
    </div>
  )
}

export default App
