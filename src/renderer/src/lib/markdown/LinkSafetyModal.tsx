import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Copy, ExternalLink } from 'lucide-react'
import { theme, alpha } from '@renderer/theme/theme'
import type { LinkSafetyModalProps } from 'streamdown'

export function LinkSafetyModal({
  isOpen,
  onClose,
  onConfirm,
  url
}: LinkSafetyModalProps): React.ReactNode {
  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 200, background: 'rgba(0, 0, 0, 0.25)' }}
      onMouseDown={onClose}
    >
      <div
        className="flex flex-col gap-3"
        style={{
          width: 340,
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
          Open external link?
        </p>
        <div
          className="text-xs m-0"
          style={{
            color: theme.text.muted,
            lineHeight: 1.55,
            padding: '8px 10px',
            background: alpha('ink', 0.04),
            borderRadius: 10,
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            overflowX: 'auto',
            whiteSpace: 'nowrap',
            scrollbarWidth: 'none',
            userSelect: 'all'
          }}
        >
          {url}
        </div>
        <div className="flex flex-col gap-1.5">
          <button
            onClick={() => {
              navigator.clipboard.writeText(url)
              onClose()
            }}
            className="flex items-center justify-center gap-2 w-full rounded-xl px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80"
            style={{
              border: 'none',
              cursor: 'pointer',
              background: alpha('ink', 0.06),
              color: theme.text.primary
            }}
          >
            <Copy size={14} strokeWidth={1.5} />
            Copy link
          </button>
          <button
            onClick={() => {
              onConfirm()
              onClose()
            }}
            className="flex items-center justify-center gap-2 w-full rounded-xl px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80"
            style={{
              border: 'none',
              cursor: 'pointer',
              background: theme.text.accent,
              color: theme.text.inverse
            }}
          >
            <ExternalLink size={14} strokeWidth={1.5} />
            Open link
          </button>
          <button
            onClick={onClose}
            className="w-full rounded-xl px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80"
            style={{
              border: 'none',
              cursor: 'pointer',
              background: 'transparent',
              color: theme.text.muted
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
