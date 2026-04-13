import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Streamdown } from 'streamdown'
import { X } from 'lucide-react'
import { theme, alpha } from '@renderer/theme/theme'

interface ChangelogModalProps {
  version: string
  onClose: () => void
}

export function ChangelogModal({ version, onClose }: ChangelogModalProps): React.JSX.Element {
  const [notes, setNotes] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    window.api.appUpdate
      .getReleaseNotes(version)
      .then((body) => setNotes(body || 'No release notes available.'))
      .catch(() => setError(true))
  }, [version])

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    },
    [onClose]
  )

  useEffect(() => {
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [handleEscape])

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 200, background: 'rgba(0, 0, 0, 0.25)' }}
      onMouseDown={onClose}
    >
      <div
        className="flex flex-col"
        style={{
          width: 480,
          maxHeight: 'min(560px, 80vh)',
          background: theme.background.surfaceFrosted,
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          border: `1px solid ${theme.border.strong}`,
          borderRadius: 16,
          boxShadow: theme.shadow.menu
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between shrink-0 px-5 pt-4 pb-3"
          style={{ borderBottom: `1px solid ${theme.border.subtle}` }}
        >
          <span className="text-sm font-medium" style={{ color: theme.text.primary }}>
            What&apos;s new in v{version}
          </span>
          <button
            onClick={onClose}
            className="p-1 rounded-md transition-opacity opacity-40 hover:opacity-70"
            style={{
              color: theme.icon.default,
              border: 'none',
              background: 'none',
              cursor: 'pointer'
            }}
            aria-label="Close"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4" style={{ minHeight: 0 }}>
          {error ? (
            <p className="text-xs" style={{ color: theme.text.muted }}>
              Failed to load release notes.
            </p>
          ) : notes === null ? (
            <p className="text-xs" style={{ color: theme.text.muted }}>
              Loading...
            </p>
          ) : (
            <div
              className="changelog-body text-[13px]"
              style={{ color: theme.text.primary, lineHeight: 1.6 }}
            >
              <Streamdown mode="static">{notes}</Streamdown>
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="shrink-0 px-5 py-3 flex justify-end"
          style={{ borderTop: `1px solid ${theme.border.subtle}` }}
        >
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-medium transition-opacity hover:opacity-80"
            style={{
              background: alpha('ink', 0.06),
              color: theme.text.primary,
              border: 'none',
              cursor: 'pointer'
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
