import { useEffect, useState } from 'react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { AppMainPanel } from '@renderer/features/layout/components/AppMainPanel'
import { AppSidebar } from '@renderer/features/layout/components/AppSidebar'
import {
  SIDEBAR_VISIBILITY_STORAGE_KEY,
  applySidebarVisibilityPreference,
  isSidebarOpenByPreference,
  parseStoredSidebarVisibility,
  resolveSidebarVisibilityPreference,
  resolveSidebarLayout
} from '@renderer/lib/sidebarLayout'

function App(): React.JSX.Element {
  const config = useAppStore((s) => s.config)
  const [cachedSidebarVisibility, setCachedSidebarVisibility] = useState(() =>
    parseStoredSidebarVisibility(globalThis.localStorage?.getItem(SIDEBAR_VISIBILITY_STORAGE_KEY))
  )
  const preferredSidebarVisibility = resolveSidebarVisibilityPreference(config, cachedSidebarVisibility ?? undefined)
  const preferredSidebarOpen = isSidebarOpenByPreference(config, cachedSidebarVisibility ?? undefined)
  const [sidebarOpenOverride, setSidebarOpenOverride] = useState<boolean | null>(null)
  const isSidebarOpen = sidebarOpenOverride ?? preferredSidebarOpen
  const sidebarLayout = resolveSidebarLayout(isSidebarOpen)
  const isConfigLoaded = config !== null

  useEffect(() => {
    setSidebarOpenOverride(null)
  }, [preferredSidebarOpen])

  useEffect(() => {
    if (!config) {
      return
    }

    globalThis.localStorage?.setItem(SIDEBAR_VISIBILITY_STORAGE_KEY, preferredSidebarVisibility)
    setCachedSidebarVisibility(preferredSidebarVisibility)
  }, [config, preferredSidebarVisibility])

  async function persistSidebarVisibility(nextSidebarOpen: boolean): Promise<void> {
    if (!config) {
      return
    }

    setSidebarOpenOverride(nextSidebarOpen)

    try {
      const nextConfig = await window.api.yachiyo.saveConfig(
        applySidebarVisibilityPreference(config, nextSidebarOpen ? 'expanded' : 'collapsed')
      )
      const nextSidebarVisibility = resolveSidebarVisibilityPreference(nextConfig)
      globalThis.localStorage?.setItem(SIDEBAR_VISIBILITY_STORAGE_KEY, nextSidebarVisibility)
      setCachedSidebarVisibility(nextSidebarVisibility)
    } catch (error) {
      setSidebarOpenOverride(null)
      window.alert(
        error instanceof Error ? error.message : 'Failed to save sidebar visibility.'
      )
    }
  }

  return (
    <div className="flex h-full overflow-hidden relative">
      {sidebarLayout.showDivider ? (
        <div
          style={{
            width: '1px',
            background: 'rgba(0,0,0,0.08)',
            position: 'absolute',
            left: `${sidebarLayout.dividerOffset}px`,
            top: 0,
            bottom: 0,
            zIndex: 1
          }}
        />
      ) : null}
      <AppSidebar
        isOpen={isSidebarOpen}
        isToggleDisabled={!isConfigLoaded}
        onToggle={() => void persistSidebarVisibility(!isSidebarOpen)}
        sidebarWidth={sidebarLayout.sidebarWidth}
        toggleTitle={sidebarLayout.toggleTitle}
      />
      <AppMainPanel
        headerPaddingLeft={sidebarLayout.mainHeaderPaddingLeft}
        isSidebarToggleDisabled={!isConfigLoaded}
        showSidebarToggle={!isSidebarOpen}
        onToggleSidebar={() => void persistSidebarVisibility(true)}
        toggleSidebarTitle={sidebarLayout.toggleTitle}
      />
    </div>
  )
}

export default App
