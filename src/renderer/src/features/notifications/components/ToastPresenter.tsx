import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { AppToast } from '@renderer/app/store/useAppStore'
import { theme } from '@renderer/theme/theme'
import { playNotificationSound } from '../lib/notificationSound'

const TOAST_AUTO_DISMISS_MS = 5000
const MAX_VISIBLE_TOASTS = 4

function Toast({ toast }: { toast: AppToast }): React.JSX.Element {
  const dismissToast = useAppStore((s) => s.dismissToast)
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const activeThreadId = useAppStore((s) => s.activeThreadId)

  const handleClick = (): void => {
    if (toast.threadId === activeThreadId) {
      dismissToast(toast.id)
    } else {
      setActiveThread(toast.threadId)
      dismissToast(toast.id)
    }
  }

  return (
    <div
      className="flex flex-col gap-1 w-72 rounded-xl px-4 py-3 cursor-pointer select-none"
      style={{
        background: theme.background.surfaceFrosted,
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        boxShadow: theme.shadow.overlay,
        border: `1px solid ${theme.border.strong}`
      }}
      onClick={handleClick}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className="text-[13px] font-semibold leading-tight truncate"
          style={{ color: theme.text.primary }}
        >
          {toast.title}
        </span>
        <button
          className="shrink-0 -mr-1 -mt-0.5 p-0.5 rounded transition-colors"
          style={{ color: theme.icon.muted }}
          onClick={(e) => {
            e.stopPropagation()
            dismissToast(toast.id)
          }}
        >
          <X size={12} />
        </button>
      </div>
      <span className="text-[12px] leading-snug line-clamp-2" style={{ color: theme.text.muted }}>
        {toast.body}
      </span>
    </div>
  )
}

export function ToastPresenter(): React.JSX.Element | null {
  const activeToasts = useAppStore((s) => s.activeToasts)
  const dismissToast = useAppStore((s) => s.dismissToast)
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const prevLengthRef = useRef(0)

  useEffect(() => {
    if (activeToasts.length > prevLengthRef.current) {
      playNotificationSound()
    }
    prevLengthRef.current = activeToasts.length
  }, [activeToasts.length])

  useEffect(() => {
    // Start timers for newly added toasts
    for (const toast of activeToasts) {
      if (!timersRef.current.has(toast.id)) {
        const timer = setTimeout(() => {
          dismissToast(toast.id)
          timersRef.current.delete(toast.id)
        }, TOAST_AUTO_DISMISS_MS)
        timersRef.current.set(toast.id, timer)
      }
    }

    // Clear timers for toasts that were manually dismissed
    const activeIds = new Set(activeToasts.map((t) => t.id))
    for (const [id, timer] of timersRef.current) {
      if (!activeIds.has(id)) {
        clearTimeout(timer)
        timersRef.current.delete(id)
      }
    }
  }, [activeToasts, dismissToast])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer)
      }
    }
  }, [])

  if (activeToasts.length === 0) return null

  const visibleToasts = activeToasts.slice(-MAX_VISIBLE_TOASTS)

  return (
    <div
      className="fixed top-4 left-1/2 -translate-x-1/2 flex flex-col gap-2 z-50 pointer-events-none items-center"
      aria-live="polite"
      aria-label="Notifications"
    >
      {visibleToasts.map((toast) => (
        <div key={toast.id} className="pointer-events-auto">
          <Toast toast={toast} />
        </div>
      ))}
    </div>
  )
}
