import { Archive, PenLine, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import type { ThreadContextOperation } from '@renderer/features/threads/lib/threadContextOperations'

export interface ThreadContextMenuPopupProps {
  onClose: () => void
  onSelect: (operationKey: ThreadContextOperation['key']) => void
  operations: ThreadContextOperation[]
  position: {
    left: number
    top: number
  }
}

function resolveOperationIcon(operationKey: ThreadContextOperation['key']): React.JSX.Element {
  if (operationKey === 'rename') {
    return <PenLine size={14} strokeWidth={1.7} />
  }

  if (operationKey === 'archive') {
    return <Archive size={14} strokeWidth={1.7} />
  }

  if (operationKey === 'restore') {
    return <RotateCcw size={14} strokeWidth={1.7} />
  }

  return <Trash2 size={14} strokeWidth={1.7} />
}

export function ThreadContextMenuPopup({
  onClose,
  onSelect,
  operations,
  position
}: ThreadContextMenuPopupProps): React.JSX.Element {
  useEffect(() => {
    const handlePointerDown = (): void => onClose()
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  return createPortal(
    <div
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      className="no-drag"
      style={{
        position: 'fixed',
        top: Math.max(12, Math.min(position.top, window.innerHeight - 12)),
        left: Math.max(12, Math.min(position.left, window.innerWidth - 196)),
        width: 184,
        padding: 6,
        background: 'rgba(248,247,245,0.98)',
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: '1px solid rgba(0,0,0,0.1)',
        borderRadius: 14,
        boxShadow: '0 14px 36px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.08)',
        zIndex: 100
      }}
    >
      {operations.map((operation) => (
        <button
          key={operation.key}
          disabled={operation.disabled}
          onClick={() => {
            onSelect(operation.key)
            onClose()
          }}
          className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors disabled:opacity-35"
          style={{
            color: operation.tone === 'danger' ? '#8E3E35' : '#2D2D2B'
          }}
          onMouseEnter={(event) => {
            ;(event.currentTarget as HTMLButtonElement).style.background = 'rgba(0,0,0,0.05)'
          }}
          onMouseLeave={(event) => {
            ;(event.currentTarget as HTMLButtonElement).style.background = 'transparent'
          }}
        >
          <span className="flex items-center gap-2.5">
            <span
              className="flex items-center justify-center shrink-0"
              style={{ width: 16, height: 16 }}
            >
              {resolveOperationIcon(operation.key)}
            </span>
            <span>{operation.label}</span>
          </span>
        </button>
      ))}
    </div>,
    document.body
  )
}
