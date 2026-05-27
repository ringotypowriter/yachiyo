import type React from 'react'
import { Settings2 } from 'lucide-react'
import { theme } from '@renderer/theme/theme'

export function SettingsShortcutButton({
  label,
  route,
  onClose
}: {
  label: string
  route: string
  onClose: () => void
}): React.ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => {
        onClose()
        window.api.openSettings(route)
      }}
      style={{
        width: 26,
        height: 26,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        border: 'none',
        borderRadius: 8,
        background: 'transparent',
        color: theme.icon.muted,
        cursor: 'default',
        transition: 'background 0.12s ease, color 0.12s ease'
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = theme.background.hover
        event.currentTarget.style.color = theme.icon.default
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent'
        event.currentTarget.style.color = theme.icon.muted
      }}
    >
      <Settings2 size={14} strokeWidth={1.7} />
    </button>
  )
}
