import { useEffect, useRef, useState } from 'react'
import type { SidebarVisibility } from '@renderer/app/types'
import { useAppStore } from '@renderer/app/store/useAppStore'
import {
  SIDEBAR_VISIBILITY_STORAGE_KEY,
  applySidebarVisibilityPreference,
  isSidebarOpenByPreference,
  parseStoredSidebarVisibility,
  resolveSidebarLayout,
  resolveSidebarVisibilityPreference,
  type SidebarLayout
} from '@renderer/lib/sidebarLayout'

export interface UseSidebarVisibilityStateResult {
  isConfigLoaded: boolean
  isSidebarOpen: boolean
  openSidebar: () => Promise<void>
  sidebarLayout: SidebarLayout
  toggleSidebar: () => Promise<void>
}

export function useSidebarVisibilityState(): UseSidebarVisibilityStateResult {
  const config = useAppStore((state) => state.config)
  const clearPendingOverrideSyncRef = useRef<(() => void) | null>(null)
  const [cachedSidebarVisibility, setCachedSidebarVisibility] = useState<SidebarVisibility | null>(
    () =>
      parseStoredSidebarVisibility(globalThis.localStorage?.getItem(SIDEBAR_VISIBILITY_STORAGE_KEY))
  )
  const preferredSidebarVisibility = resolveSidebarVisibilityPreference(
    config,
    cachedSidebarVisibility ?? undefined
  )
  const preferredSidebarOpen = isSidebarOpenByPreference(
    config,
    cachedSidebarVisibility ?? undefined
  )
  const [sidebarOpenOverride, setSidebarOpenOverride] = useState<boolean | null>(null)
  const isSidebarOpen = sidebarOpenOverride ?? preferredSidebarOpen
  const sidebarLayout = resolveSidebarLayout(isSidebarOpen)

  useEffect(() => {
    return () => {
      clearPendingOverrideSyncRef.current?.()
    }
  }, [])

  useEffect(() => {
    if (!config) {
      return
    }

    globalThis.localStorage?.setItem(SIDEBAR_VISIBILITY_STORAGE_KEY, preferredSidebarVisibility)
  }, [config, preferredSidebarVisibility])

  function clearPendingOverrideSync(): void {
    clearPendingOverrideSyncRef.current?.()
    clearPendingOverrideSyncRef.current = null
  }

  async function persistSidebarVisibility(nextSidebarOpen: boolean): Promise<void> {
    if (!config) {
      return
    }

    clearPendingOverrideSync()
    const previousPreferredSidebarOpen = preferredSidebarOpen
    const fallbackVisibility = cachedSidebarVisibility ?? undefined
    setSidebarOpenOverride(nextSidebarOpen)

    try {
      await window.api.yachiyo.saveConfig(
        applySidebarVisibilityPreference(config, nextSidebarOpen ? 'expanded' : 'collapsed')
      )
      const nextSidebarVisibility = nextSidebarOpen ? 'expanded' : 'collapsed'
      setCachedSidebarVisibility(nextSidebarVisibility)
      const currentPreferredSidebarOpen = isSidebarOpenByPreference(
        useAppStore.getState().config,
        fallbackVisibility
      )

      if (currentPreferredSidebarOpen !== previousPreferredSidebarOpen) {
        setSidebarOpenOverride(null)
        return
      }

      clearPendingOverrideSyncRef.current = useAppStore.subscribe((state) => {
        if (
          isSidebarOpenByPreference(state.config, fallbackVisibility) ===
          previousPreferredSidebarOpen
        ) {
          return
        }

        clearPendingOverrideSync()
        setSidebarOpenOverride(null)
      })
    } catch (error) {
      clearPendingOverrideSync()
      setSidebarOpenOverride(null)
      window.alert(error instanceof Error ? error.message : 'Failed to save sidebar visibility.')
    }
  }

  return {
    isConfigLoaded: config !== null,
    isSidebarOpen,
    openSidebar: () => persistSidebarVisibility(true),
    sidebarLayout,
    toggleSidebar: () => persistSidebarVisibility(!isSidebarOpen)
  }
}
