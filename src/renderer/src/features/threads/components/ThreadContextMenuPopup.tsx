import {
  Archive,
  FolderPlus,
  FolderMinus,
  ListChecks,
  MessageSquare,
  Paintbrush,
  PenLine,
  SendHorizonal,
  Sparkles,
  Star,
  Trash2
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  resolveThreadColorOperationTag,
  type ThreadContextOperation
} from '@renderer/features/threads/lib/threadContextOperations'
import { THREAD_COLOR_VALUES } from '@renderer/features/threads/lib/threadColorPalette'
import { theme } from '@renderer/theme/theme'

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
  if (operationKey === 'enter-select-mode') {
    return <ListChecks size={14} strokeWidth={1.7} />
  }

  if (operationKey === 'regenerate-title') {
    return <Sparkles size={14} strokeWidth={1.7} />
  }

  if (operationKey === 'rename') {
    return <PenLine size={14} strokeWidth={1.7} />
  }

  if (operationKey === 'archive') {
    return <Archive size={14} strokeWidth={1.7} />
  }

  if (operationKey === 'compact-to-another-thread') {
    return <SendHorizonal size={14} strokeWidth={1.7} />
  }

  if (operationKey === 'restore') {
    return <MessageSquare size={14} strokeWidth={1.7} />
  }

  if (operationKey === 'create-folder') {
    return <FolderPlus size={14} strokeWidth={1.7} />
  }

  if (operationKey === 'remove-from-folder') {
    return <FolderMinus size={14} strokeWidth={1.7} />
  }

  if (operationKey === 'star') {
    return <Star size={14} strokeWidth={1.7} />
  }

  if (operationKey === 'unstar') {
    return <Star size={14} strokeWidth={0} fill="currentColor" />
  }

  const colorTag = resolveThreadColorOperationTag(operationKey)
  if (colorTag !== undefined) {
    return (
      <Paintbrush
        size={14}
        strokeWidth={1.9}
        style={{ color: colorTag ? THREAD_COLOR_VALUES[colorTag] : theme.text.secondary }}
      />
    )
  }

  return <Trash2 size={14} strokeWidth={1.7} />
}

export function ThreadContextMenuPopup({
  onClose,
  onSelect,
  operations,
  position
}: ThreadContextMenuPopupProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [resolvedTop, setResolvedTop] = useState(position.top)

  useEffect(() => {
    const handlePointerDown = (): void => onClose()
    const handleContextMenu = (): void => onClose()
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('contextmenu', handleContextMenu, true)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('contextmenu', handleContextMenu, true)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [onClose])

  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const menuHeight = el.offsetHeight
    const margin = 12
    if (position.top + menuHeight > window.innerHeight - margin) {
      setResolvedTop(Math.max(margin, position.top - menuHeight))
    } else {
      setResolvedTop(position.top)
    }
  }, [position.top, operations.length])

  return createPortal(
    <div
      ref={menuRef}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      className="no-drag"
      data-no-drag
      style={{
        position: 'fixed',
        top: resolvedTop,
        left: Math.max(12, Math.min(position.left, window.innerWidth - 196)),
        width: 184,
        padding: 6,
        background: theme.background.surfaceFrosted,
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: `1px solid ${theme.border.strong}`,
        borderRadius: 14,
        boxShadow: theme.shadow.menu,
        zIndex: 100
      }}
    >
      {operations.map((operation) => (
        <div key={operation.key}>
          {operation.separatorBefore ? (
            <div
              style={{
                height: 1,
                margin: '4px 8px',
                background: theme.border.default
              }}
            />
          ) : null}
          <button
            disabled={operation.disabled}
            onClick={() => {
              onSelect(operation.key)
              onClose()
            }}
            className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors disabled:opacity-35"
            style={{
              color: operation.tone === 'danger' ? theme.text.dangerStrong : theme.text.primary,
              background: operation.active ? theme.background.hoverStrong : 'transparent'
            }}
            onMouseEnter={(event) => {
              ;(event.currentTarget as HTMLButtonElement).style.background =
                theme.background.hoverStrong
            }}
            onMouseLeave={(event) => {
              ;(event.currentTarget as HTMLButtonElement).style.background = operation.active
                ? theme.background.hoverStrong
                : 'transparent'
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
        </div>
      ))}
    </div>,
    document.body
  )
}
