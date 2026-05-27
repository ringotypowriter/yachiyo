import { useEffect, useId } from 'react'
import { createPortal } from 'react-dom'
import { LoaderCircle } from 'lucide-react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { alpha, theme } from '@renderer/theme/theme'

export function GlobalProcessingModal(): React.JSX.Element | null {
  const task = useAppStore((state) => state.globalProcessingTasks.at(-1) ?? null)
  const titleId = useId()

  useEffect(() => {
    if (!task) return

    const blockKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
    }

    document.addEventListener('keydown', blockKeyDown, true)
    return () => document.removeEventListener('keydown', blockKeyDown, true)
  }, [task])

  if (!task) return null

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center no-drag"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-busy="true"
      style={{
        zIndex: 5000,
        background: alpha('ink', 0.16),
        backdropFilter: 'blur(12px) saturate(1.15)',
        WebkitBackdropFilter: 'blur(12px) saturate(1.15)'
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div
        className="flex items-center gap-3"
        style={{
          width: 'min(320px, calc(100vw - 48px))',
          minHeight: 76,
          padding: '16px 18px',
          borderRadius: 16,
          background: theme.background.surfaceFrosted,
          border: `1px solid ${theme.border.strong}`,
          boxShadow: theme.shadow.menu
        }}
      >
        <span
          className="flex shrink-0 items-center justify-center rounded-full"
          style={{
            width: 38,
            height: 38,
            color: theme.text.accent,
            background: theme.background.accentSoft,
            border: `1px solid ${theme.border.accent}`
          }}
        >
          <LoaderCircle size={20} strokeWidth={1.9} className="global-processing-modal__spinner" />
        </span>
        <div className="min-w-0">
          <p
            id={titleId}
            className="m-0 text-sm font-semibold"
            style={{ color: theme.text.primary, lineHeight: 1.35 }}
          >
            Processing
          </p>
          <p
            className="m-0 mt-0.5 truncate text-xs"
            style={{ color: theme.text.muted, lineHeight: 1.45 }}
          >
            {task.label}
          </p>
        </div>
      </div>
    </div>,
    document.body
  )
}
