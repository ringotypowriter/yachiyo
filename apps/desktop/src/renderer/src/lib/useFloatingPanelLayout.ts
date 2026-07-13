import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, RefObject } from 'react'

import {
  resolveFloatingPanelLayout,
  type FloatingPanelLayout,
  type FloatingPanelRect
} from './floatingPanelLayout'

interface UseFloatingPanelLayoutOptions {
  open: boolean
  anchor?: FloatingPanelRect | null
  referenceRef?: RefObject<HTMLElement | null>
  floatingRef?: RefObject<HTMLDivElement | null>
  width: number | 'anchor'
  maxHeight: number
  preferredPlacement: 'top' | 'bottom'
  alignment?: 'start' | 'center' | 'end'
  gap?: number
  margin?: number
}

interface UseFloatingPanelLayoutResult {
  floatingRef: RefObject<HTMLDivElement | null>
  layout: FloatingPanelLayout | null
  style: CSSProperties
  updateLayout: () => void
}

function layoutsMatch(current: FloatingPanelLayout | null, next: FloatingPanelLayout): boolean {
  return (
    current?.top === next.top &&
    current.left === next.left &&
    current.width === next.width &&
    current.maxHeight === next.maxHeight &&
    current.placement === next.placement
  )
}

export function useFloatingPanelLayout({
  open,
  anchor,
  referenceRef,
  floatingRef: providedFloatingRef,
  width,
  maxHeight,
  preferredPlacement,
  alignment = 'start',
  gap = 8,
  margin = 12
}: UseFloatingPanelLayoutOptions): UseFloatingPanelLayoutResult {
  const internalFloatingRef = useRef<HTMLDivElement>(null)
  const floatingRef = providedFloatingRef ?? internalFloatingRef
  const naturalHeightRef = useRef(0)
  const [layout, setLayout] = useState<FloatingPanelLayout | null>(null)

  const updateLayout = useCallback((): void => {
    if (!open) return
    const currentAnchor = referenceRef?.current?.getBoundingClientRect() ?? anchor
    const floating = floatingRef.current
    if (!currentAnchor || !floating) return

    const naturalHeight = Math.min(
      maxHeight,
      Math.max(naturalHeightRef.current, floating.offsetHeight, floating.scrollHeight)
    )
    naturalHeightRef.current = naturalHeight
    const preferredWidth = width === 'anchor' ? currentAnchor.right - currentAnchor.left : width
    const next = resolveFloatingPanelLayout({
      anchor: currentAnchor,
      panel: { width: preferredWidth, height: naturalHeight },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      preferredPlacement,
      alignment,
      gap,
      margin
    })

    setLayout((current) => (layoutsMatch(current, next) ? current : next))
  }, [
    alignment,
    anchor,
    floatingRef,
    gap,
    margin,
    maxHeight,
    open,
    preferredPlacement,
    referenceRef,
    width
  ])

  useLayoutEffect(() => {
    if (!open) {
      naturalHeightRef.current = 0
      return undefined
    }

    let animationFrame = 0
    const scheduleUpdate = (): void => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(updateLayout)
    }

    updateLayout()
    window.addEventListener('resize', scheduleUpdate)
    window.addEventListener('scroll', scheduleUpdate, true)
    window.visualViewport?.addEventListener('resize', scheduleUpdate)
    window.visualViewport?.addEventListener('scroll', scheduleUpdate)

    const resizeObserver = new ResizeObserver(scheduleUpdate)
    if (floatingRef.current) resizeObserver.observe(floatingRef.current)
    if (referenceRef?.current) resizeObserver.observe(referenceRef.current)

    return () => {
      cancelAnimationFrame(animationFrame)
      resizeObserver.disconnect()
      window.removeEventListener('resize', scheduleUpdate)
      window.removeEventListener('scroll', scheduleUpdate, true)
      window.visualViewport?.removeEventListener('resize', scheduleUpdate)
      window.visualViewport?.removeEventListener('scroll', scheduleUpdate)
    }
  }, [floatingRef, open, referenceRef, updateLayout])

  return {
    floatingRef,
    layout: open ? layout : null,
    updateLayout,
    style:
      open && layout
        ? {
            position: 'fixed',
            top: layout.top,
            left: layout.left,
            width: layout.width,
            maxHeight: layout.maxHeight
          }
        : {
            position: 'fixed',
            top: 0,
            left: 0,
            width: width === 'anchor' ? 0 : width,
            maxHeight,
            visibility: 'hidden'
          }
  }
}
