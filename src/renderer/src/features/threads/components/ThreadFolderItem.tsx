import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  FolderOpen,
  FolderClosed,
  PenLine,
  Trash2,
  Paintbrush,
  Archive,
  RotateCcw
} from 'lucide-react'
import type { FolderColorTag, FolderRecord } from '@renderer/app/types'
import { imeSafeEnter } from '@renderer/lib/imeUtils'
import { theme } from '@renderer/theme/theme'

const FOLDER_COLORS: Record<FolderColorTag, string> = {
  coral: '#E25D5D',
  azure: '#4A90D9',
  emerald: '#3CB371',
  amethyst: '#9B72CF',
  slate: '#708090'
}

const COLOR_LABELS: Record<FolderColorTag, string> = {
  coral: 'Mark it Coral',
  azure: 'Mark it Azure',
  emerald: 'Mark it Emerald',
  amethyst: 'Mark it Amethyst',
  slate: 'Mark it Slate'
}

function folderIconColor(colorTag: FolderColorTag | null | undefined): string {
  return colorTag && FOLDER_COLORS[colorTag] ? FOLDER_COLORS[colorTag] : theme.text.secondary
}

interface ThreadFolderItemProps {
  folder: FolderRecord
  isCollapsed: boolean
  threadCount: number
  mode: 'active' | 'archived'
  onToggle: () => void
  onRename: (title: string) => void
  onDelete: () => void
  onSetColor: (colorTag: FolderColorTag | null) => void
  onArchiveAll: () => void
  onRestoreAll: () => void
  children: React.ReactNode
}

export function ThreadFolderItem({
  folder,
  isCollapsed,
  threadCount,
  mode,
  onToggle,
  onRename,
  onDelete,
  onSetColor,
  onArchiveAll,
  onRestoreAll,
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      setIsRenaming(false)
      return
    }
    imeSafeEnter(commitRename)(e)
  }

  const handleContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const iconColor = folderIconColor(folder.colorTag)

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
          <FolderClosed size={16} style={{ color: iconColor, flexShrink: 0 }} />
        ) : (
          <FolderOpen size={16} style={{ color: iconColor, flexShrink: 0 }} />
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
                background: folder.colorTag
                  ? folderIconColor(folder.colorTag)
                  : theme.border.default,
                opacity: folder.colorTag ? 0.4 : 1
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
          currentColor={folder.colorTag ?? null}
          mode={mode}
          onRename={() => {
            setContextMenu(null)
            handleDoubleClick()
          }}
          onDelete={() => {
            setContextMenu(null)
            onDelete()
          }}
          onSetColor={(colorTag) => {
            setContextMenu(null)
            onSetColor(colorTag)
          }}
          onArchiveAll={() => {
            setContextMenu(null)
            onArchiveAll()
          }}
          onRestoreAll={() => {
            setContextMenu(null)
            onRestoreAll()
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
  currentColor,
  mode,
  onRename,
  onDelete,
  onSetColor,
  onArchiveAll,
  onRestoreAll,
  onClose
}: {
  x: number
  y: number
  currentColor: FolderColorTag | null
  mode: 'active' | 'archived'
  onRename: () => void
  onDelete: () => void
  onSetColor: (colorTag: FolderColorTag | null) => void
  onArchiveAll: () => void
  onRestoreAll: () => void
  onClose: () => void
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [resolvedTop, setResolvedTop] = useState(y)

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

  useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const menuHeight = el.offsetHeight
    const margin = 12
    if (y + menuHeight > window.innerHeight - margin) {
      setResolvedTop(Math.max(margin, y - menuHeight))
    } else {
      setResolvedTop(y)
    }
  }, [y])

  const colorTags: FolderColorTag[] = ['coral', 'azure', 'emerald', 'amethyst', 'slate']

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
        top: resolvedTop,
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
      <MenuItem icon={<PenLine size={14} strokeWidth={1.7} />} onClick={onRename}>
        Rename
      </MenuItem>
      {mode === 'active' ? (
        <MenuItem icon={<Archive size={14} strokeWidth={1.7} />} onClick={onArchiveAll}>
          Archive All
        </MenuItem>
      ) : (
        <MenuItem icon={<RotateCcw size={14} strokeWidth={1.7} />} onClick={onRestoreAll}>
          Restore All
        </MenuItem>
      )}
      <MenuItem
        icon={<Trash2 size={14} strokeWidth={1.7} />}
        onClick={onDelete}
        color={theme.text.danger}
      >
        Discard Folder
      </MenuItem>

      <div
        style={{
          height: 1,
          margin: '4px 8px',
          background: theme.border.default
        }}
      />

      <MenuItem
        icon={<FolderClosed size={14} strokeWidth={1.7} style={{ color: theme.text.secondary }} />}
        onClick={() => onSetColor(null)}
        active={currentColor === null}
      >
        Mark it Default
      </MenuItem>
      {colorTags.map((tag) => (
        <MenuItem
          key={tag}
          icon={<Paintbrush size={14} strokeWidth={1.7} style={{ color: FOLDER_COLORS[tag] }} />}
          onClick={() => onSetColor(tag)}
          active={currentColor === tag}
        >
          {COLOR_LABELS[tag]}
        </MenuItem>
      ))}
    </div>,
    document.body
  )
}

function MenuItem({
  icon,
  onClick,
  color,
  active,
  children
}: {
  icon: React.ReactNode
  onClick: () => void
  color?: string
  active?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      className="w-full rounded-lg px-3 py-2 text-left text-sm transition-colors"
      style={{
        color: color ?? theme.text.primary,
        background: active ? theme.background.hoverStrong : 'transparent'
      }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.background = theme.background.hoverStrong
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLButtonElement).style.background = active
          ? theme.background.hoverStrong
          : 'transparent'
      }}
      onClick={onClick}
    >
      <span className="flex items-center gap-2.5">
        <span
          className="flex items-center justify-center shrink-0"
          style={{ width: 16, height: 16 }}
        >
          {icon}
        </span>
        <span>{children}</span>
      </span>
    </button>
  )
}
