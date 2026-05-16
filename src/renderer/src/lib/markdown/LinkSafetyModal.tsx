import { Copy, ExternalLink } from 'lucide-react'
import { theme, alpha } from '@renderer/theme/theme'
import { AppDialog } from '@renderer/components/AppDialog'
import type { LinkSafetyModalProps } from 'streamdown'

export function LinkSafetyModal({
  isOpen,
  onClose,
  onConfirm,
  url
}: LinkSafetyModalProps): React.ReactNode {
  if (!isOpen) return null

  return (
    <AppDialog
      title="Open external link?"
      width={340}
      actions={[
        {
          key: 'copy',
          label: 'Copy link',
          icon: <Copy size={14} strokeWidth={1.5} />
        },
        {
          key: 'open',
          label: 'Open link',
          tone: 'accent',
          autoFocus: true,
          icon: <ExternalLink size={14} strokeWidth={1.5} />
        },
        { key: 'cancel', label: 'Cancel' }
      ]}
      onAction={(key) => {
        if (key === 'copy') {
          navigator.clipboard.writeText(url)
          onClose()
          return
        }
        if (key === 'open') {
          onConfirm()
          onClose()
          return
        }
        onClose()
      }}
      onClose={onClose}
    >
      <div
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
    </AppDialog>
  )
}
