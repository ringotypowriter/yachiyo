import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FolderOpen, FolderClosed } from 'lucide-react'
import type { FolderRecord } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'

interface ThreadFolderItemProps {
  folder: FolderRecord
  isCollapsed: boolean
  threadCount: number
  onToggle: () => void
  onRename: (title: string) => void
  onDelete: () => void
  children: React.ReactNode
}

export function ThreadFolderItem({
  folder,
  isCollapsed,
  threadCount,
  onToggle,
  onRename,
  onDelete,
  children
}: ThreadFolderItemProps): React.JSX.Element {
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(folder.title)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const handleDoubleClick = (): void => {
    setRenameValue(folder.title)
    setIsRenaming(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }

  const commitRename = (): void => {
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== folder.title) {
      onRename(trimmed)
    }
    setIsRenaming(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      setIsRenaming(false)
    }
  }

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  return (
    <div>
      <div
        className="flex items-center gap-2 rounded-lg px-2.5 py-2 cursor-pointer select-none"
        style={{ color: theme.text.primary }}
        onClick={onToggle}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
      >
        {isCollapsed ? (
          <FolderClosed size={16} style={{ color: theme.text.secondary, flexShrink: 0 }} />
        ) : (
          <FolderOpen size={16} style={{ color: theme.text.secondary, flexShrink: 0 }} />
        )}
        {isRenaming ? (
          <input
            ref={inputRef}
            className="flex-1 min-w-0 rounded px-1 text-sm outline-none"
            style={{
              background: theme.background.surface,
              color: theme.text.primary,
              border: `1px solid ${theme.border.input}`
            }}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <span className="flex-1 min-w-0 truncate text-sm font-semibold">{folder.title}</span>
        )}
        <span className="text-xs tabular-nums" style={{ color: theme.text.muted, flexShrink: 0 }}>
          {threadCount}
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateRows: isCollapsed ? '0fr' : '1fr',
          opacity: isCollapsed ? 0 : 1,
          transition: 'grid-template-rows 0.2s ease, opacity 0.15s ease'
        }}
      >
        <div className="overflow-hidden">
          <div className="relative ml-3.75 pl-3">
            <div
              className="absolute left-0 top-0 bottom-0"
              style={{
                width: 1,
                background: theme.border.default
              }}
            />
            {children}
          </div>
        </div>
      </div>

      {contextMenu && (
        <FolderContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onRename={() => {
            setContextMenu(null)
            handleDoubleClick()
          }}
          onDelete={() => {
            setContextMenu(null)
            onDelete()
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

function FolderContextMenu({
  x,
  y,
  onRename,
  onDelete,
  onClose
}: {
  x: number
  y: number
  onRename: () => void
  onDelete: () => void
  onClose: () => void
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handlePointerDown = (): void => onClose()
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
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
      ref={menuRef}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      className="no-drag"
      data-no-drag
      style={{
        position: 'fixed',
        left: Math.max(12, Math.min(x, window.innerWidth - 196)),
        top: y,
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
      <button
        className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors"
        style={{ color: theme.text.primary }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.background = theme.background.hoverStrong
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
        }}
        onClick={onRename}
      >
        Rename
      </button>
      <button
        className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors"
        style={{ color: theme.text.danger }}
        onMouseEnter={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.background = theme.background.hoverStrong
        }}
        onMouseLeave={(e) => {
          ;(e.currentTarget as HTMLButtonElement).style.background = 'transparent'
        }}
        onClick={onDelete}
      >
        Discard Folder
      </button>
    </div>,
    document.body
  )
}
