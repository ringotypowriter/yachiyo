import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { theme, alpha } from '@renderer/theme/theme'

export interface ConfirmDialogAction {
  key: string
  label: string
  tone?: 'default' | 'accent' | 'danger'
}

export interface ConfirmDialogProps {
  title: string
  actions: ConfirmDialogAction[]
  onSelect: (key: string) => void
  onClose: () => void
}

export function ConfirmDialog({
  title,
  actions,
  onSelect,
  onClose
}: ConfirmDialogProps): React.JSX.Element {
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  function resolveButtonStyle(tone?: 'default' | 'accent' | 'danger'): React.CSSProperties {
    if (tone === 'accent') {
      return {
        background: theme.text.accent,
        color: theme.text.inverse
      }
    }
    if (tone === 'danger') {
      return {
        background: alpha('danger', 0.08),
        color: theme.text.dangerStrong
      }
    }
    return {
      background: alpha('ink', 0.06),
      color: theme.text.primary
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 200, background: 'rgba(0, 0, 0, 0.25)' }}
      onMouseDown={onClose}
    >
      <div
        className="flex flex-col gap-3"
        style={{
          width: 300,
          padding: 20,
          background: theme.background.surfaceFrosted,
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          border: `1px solid ${theme.border.strong}`,
          borderRadius: 16,
          boxShadow: theme.shadow.menu
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <p
          className="text-sm font-medium m-0 text-center"
          style={{ color: theme.text.primary, lineHeight: 1.5 }}
        >
          {title}
        </p>
        <div className="flex flex-col gap-1.5">
          {actions.map((action) => (
            <button
              key={action.key}
              onClick={() => onSelect(action.key)}
              className="w-full rounded-xl px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80"
              style={{
                border: 'none',
                cursor: 'pointer',
                ...resolveButtonStyle(action.tone)
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
