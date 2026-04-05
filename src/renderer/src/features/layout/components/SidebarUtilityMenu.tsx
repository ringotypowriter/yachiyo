import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Languages, NotebookPen, Radio } from 'lucide-react'
import type { ConnectionStatus } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'

export interface SidebarUtilityMenuProps {
  anchorRect: DOMRect
  connectionStatus: ConnectionStatus
  showExternalThreads: boolean
  onToggleExternalThreads: () => void
  onOpenTranslator: () => void
  onOpenJotdown: () => void
  onClose: () => void
}

export function SidebarUtilityMenu({
  anchorRect,
  connectionStatus,
  showExternalThreads,
  onToggleExternalThreads,
  onOpenTranslator,
  onOpenJotdown,
  onClose
}: SidebarUtilityMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
  }, [])

  useEffect(() => {
    const handlePointerDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  const isConnected = connectionStatus === 'connected'
  const menuWidth = 200
  const left = Math.max(12, Math.min(anchorRect.left, window.innerWidth - menuWidth - 12))

  return createPortal(
    <div
      ref={menuRef}
      onMouseDown={(e) => e.stopPropagation()}
      className="no-drag"
      style={{
        position: 'fixed',
        bottom: window.innerHeight - anchorRect.top + 6,
        left,
        width: menuWidth,
        padding: 6,
        background: theme.background.surfaceFrosted,
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: `1px solid ${theme.border.strong}`,
        borderRadius: 14,
        boxShadow: theme.shadow.menu,
        zIndex: 100,
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(6px)',
        transition: 'opacity 0.15s ease, transform 0.15s ease'
      }}
    >
      {/* Connection status */}
      <div
        className="flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px]"
        style={{ color: theme.text.secondary }}
      >
        <span
          className="rounded-full shrink-0"
          style={{
            width: 8,
            height: 8,
            background: isConnected ? theme.status.success : theme.status.danger
          }}
        />
        <span>{isConnected ? 'Server ready' : 'Server offline'}</span>
      </div>

      {/* Divider */}
      <div className="mx-2 my-1" style={{ height: 1, background: theme.border.panel }} />

      {/* External threads toggle */}
      <button
        onClick={() => {
          onToggleExternalThreads()
        }}
        className="w-full rounded-lg px-3 py-2 text-left text-[13px] transition-colors"
        style={{ color: showExternalThreads ? theme.text.accentStrong : theme.text.primary }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLElement).style.background = theme.background.hoverStrong
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLElement).style.background = 'transparent'
        }}
      >
        <span className="flex items-center gap-2.5">
          <Radio size={14} strokeWidth={1.5} />
          <span>External threads</span>
          {showExternalThreads && (
            <span
              className="ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded"
              style={{ background: theme.background.accentSurface, color: theme.text.accent }}
            >
              ON
            </span>
          )}
        </span>
      </button>

      {/* Translator */}
      <button
        onClick={() => {
          onOpenTranslator()
          onClose()
        }}
        className="w-full rounded-lg px-3 py-2 text-left text-[13px] transition-colors"
        style={{ color: theme.text.primary }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLElement).style.background = theme.background.hoverStrong
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLElement).style.background = 'transparent'
        }}
      >
        <span className="flex items-center gap-2.5">
          <Languages size={14} strokeWidth={1.5} />
          <span>Translator</span>
        </span>
      </button>

      {/* Jot Down */}
      <button
        onClick={() => {
          onOpenJotdown()
          onClose()
        }}
        className="w-full rounded-lg px-3 py-2 text-left text-[13px] transition-colors"
        style={{ color: theme.text.primary }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLElement).style.background = theme.background.hoverStrong
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLElement).style.background = 'transparent'
        }}
      >
        <span className="flex items-center gap-2.5">
          <NotebookPen size={14} strokeWidth={1.5} />
          <span>Jot Down</span>
        </span>
      </button>
    </div>,
    document.body
  )
}
