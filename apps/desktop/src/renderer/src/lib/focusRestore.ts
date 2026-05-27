import { useLayoutEffect, useRef } from 'react'

export interface RestorableFocusElement {
  isConnected?: boolean
  focus: (options?: FocusOptions) => void
}

function activeRestorableElement(): HTMLElement | null {
  if (typeof document === 'undefined' || typeof HTMLElement === 'undefined') return null

  const activeElement = document.activeElement
  if (!(activeElement instanceof HTMLElement)) return null
  if (activeElement === document.body || activeElement === document.documentElement) return null
  return activeElement
}

export function restoreFocusToElement(target: RestorableFocusElement | null): boolean {
  if (!target || target.isConnected === false) return false
  target.focus({ preventScroll: true })
  return true
}

export function useRestoreFocusOnUnmount(enabled = true): void {
  const focusTargetRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    if (!enabled) return
    focusTargetRef.current = activeRestorableElement()

    return () => {
      restoreFocusToElement(focusTargetRef.current)
      focusTargetRef.current = null
    }
  }, [enabled])
}
