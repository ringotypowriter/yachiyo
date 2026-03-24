import { useCallback, useEffect, useRef, useState } from 'react'
import type { SidebarVisibility } from '@renderer/app/types'
import { useAppStore } from '@renderer/app/store/useAppStore'
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_VISIBILITY_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_KEY,
  applySidebarVisibilityPreference,
  isSidebarOpenByPreference,
  parseStoredSidebarVisibility,
  parseStoredSidebarWidth,
  resolveSidebarLayout,
  resolveSidebarVisibilityPreference,
  type SidebarLayout
} from '@renderer/lib/sidebarLayout'

export interface UseSidebarVisibilityStateResult {
  isConfigLoaded: boolean
  isDragging: boolean
  isSidebarOpen: boolean
  onDragStart: (e: React.MouseEvent) => void
  openSidebar: () => Promise<void>
  setWidth: (w: number) => void
  sidebarLayout: SidebarLayout
  sidebarWidth: number
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

  const [sidebarWidth, setSidebarWidth] = useState<number>(
    () =>
      parseStoredSidebarWidth(globalThis.localStorage?.getItem(SIDEBAR_WIDTH_STORAGE_KEY)) ??
      DEFAULT_SIDEBAR_WIDTH
  )
  const [isDragging, setIsDragging] = useState(false)
  const sidebarLayout = resolveSidebarLayout(isSidebarOpen, sidebarWidth)

  useEffect(() => {
    const handler = (e: StorageEvent): void => {
      if (e.key !== SIDEBAR_WIDTH_STORAGE_KEY) return
      const parsed = parseStoredSidebarWidth(e.newValue)
      if (parsed != null) {
        setSidebarWidth(parsed)
      }
    }
    window.addEventListener('storage', handler)
    return () => window.removeEventListener('storage', handler)
  }, [])

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

  const setWidth = useCallback((w: number) => {
    const clamped = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, w))
    setSidebarWidth(clamped)
    globalThis.localStorage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clamped))
  }, [])

  const onDragStart = useCallback(
    (e: React.MouseEvent) => {
      const startX = e.clientX
      const startWidth = sidebarWidth
      let currentWidth = startWidth

      setIsDragging(true)

      const onMouseMove = (event: MouseEvent): void => {
        const delta = event.clientX - startX
        const next = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, startWidth + delta))
        currentWidth = next
        setSidebarWidth(next)
      }

      const stopDragging = (finalWidth: number): void => {
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
        window.removeEventListener('blur', onWindowBlur)
        setIsDragging(false)
        globalThis.localStorage?.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(finalWidth))
      }

      const onMouseUp = (event: MouseEvent): void => {
        const finalWidth = Math.min(
          MAX_SIDEBAR_WIDTH,
          Math.max(MIN_SIDEBAR_WIDTH, startWidth + (event.clientX - startX))
        )
        stopDragging(finalWidth)
      }

      const onWindowBlur = (): void => {
        stopDragging(currentWidth)
      }

      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
      window.addEventListener('blur', onWindowBlur)
    },
    [sidebarWidth]
  )

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
    isDragging,
    isSidebarOpen,
    onDragStart,
    openSidebar: () => persistSidebarVisibility(true),
    setWidth,
    sidebarLayout,
    sidebarWidth,
    toggleSidebar: () => persistSidebarVisibility(!isSidebarOpen)
  }
}
