import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ListFilter, X } from 'lucide-react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { hasActiveMultiFilter, type SidebarFilter } from '@renderer/app/store/useAppStore'
import {
  THREAD_COLOR_FILTER_LABELS,
  THREAD_COLOR_TAGS,
  THREAD_COLOR_VALUES
} from '@renderer/features/threads/lib/threadColorPalette'
import {
  TEMPORARY_WORKSPACE_FILTER,
  resolveWorkspaceDisplayName,
  resolveWorkspaceFilterOptions
} from '@renderer/features/threads/lib/threadWorkspaceFilterOptions'
import { theme, alpha } from '@renderer/theme/theme'

const EMPTY_WORKSPACE_PATHS: string[] = []

function resolveFilterLabel(filter: SidebarFilter): string {
  const hasMulti = hasActiveMultiFilter(filter)
  if (!hasMulti) return filter.base === 'archived' ? 'Archived' : 'All'

  const parts: string[] = []
  for (const tag of filter.colorTags) {
    parts.push(THREAD_COLOR_FILTER_LABELS[tag])
  }
  for (const workspacePath of filter.workspacePaths) {
    parts.push(resolveWorkspaceDisplayName(workspacePath))
  }
  if (filter.running) parts.push('Running')
  if (filter.justDone) parts.push('Just Done')
  if (filter.folderOnly) parts.push('Folders')

  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return parts.join(' + ')
  return `${parts.length} filters`
}

function useWorkspaceFilterOptions(): Array<{ path: string; displayName: string }> {
  const threads = useAppStore((s) => s.threads)
  const archivedThreads = useAppStore((s) => s.archivedThreads)
  const savedPaths = useAppStore((s) => s.config?.workspace?.savedPaths ?? EMPTY_WORKSPACE_PATHS)

  return useMemo(
    () => resolveWorkspaceFilterOptions({ savedPaths, threads, archivedThreads }),
    [savedPaths, threads, archivedThreads]
  )
}

export function SidebarFilterBar(): React.JSX.Element {
  const sidebarFilter = useAppStore((s) => s.sidebarFilter)
  const unreadArchivedCount = useAppStore(
    (s) => s.archivedThreads.filter((t) => t.archivedAt && !t.readAt).length
  )
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const hasMulti = hasActiveMultiFilter(sidebarFilter)
  const isActive = hasMulti || sidebarFilter.base === 'archived'
  const label = resolveFilterLabel(sidebarFilter)
  const showUnreadDot = unreadArchivedCount > 0 && sidebarFilter.base !== 'archived' && !hasMulti

  return (
    <div className="shrink-0 min-w-0 flex items-center">
      <button
        ref={triggerRef}
        aria-label="Filter chats"
        onClick={() => {
          if (anchorRect) {
            setAnchorRect(null)
          } else {
            setAnchorRect(triggerRef.current!.getBoundingClientRect())
          }
        }}
        className="relative flex min-w-0 items-center gap-1.5 px-2.5 py-1 rounded-lg transition-colors"
        style={{
          color: isActive ? theme.text.accentStrong : theme.text.secondary,
          background: anchorRect
            ? theme.background.hoverStrong
            : isActive
              ? theme.background.accentSoft
              : 'transparent',
          fontSize: '12px',
          fontWeight: 500,
          lineHeight: 1,
          maxWidth: 128
        }}
        onMouseEnter={(e) => {
          if (!anchorRect)
            (e.currentTarget as HTMLElement).style.background = theme.background.hoverStrong
        }}
        onMouseLeave={(e) => {
          if (!anchorRect) {
            ;(e.currentTarget as HTMLElement).style.background = isActive
              ? theme.background.accentSoft
              : 'transparent'
          }
        }}
      >
        <ListFilter size={13} strokeWidth={1.8} />
        <span className="truncate">{label}</span>
        <ChevronDown
          size={10}
          strokeWidth={2}
          style={{
            transform: anchorRect ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s ease'
          }}
        />
        {showUnreadDot && (
          <span
            className="absolute -top-0.5 -right-0.5 rounded-full"
            style={{
              width: 6,
              height: 6,
              background: theme.text.accent
            }}
          />
        )}
      </button>
      {anchorRect && (
        <SidebarFilterDropdown anchorRect={anchorRect} onClose={() => setAnchorRect(null)} />
      )}
    </div>
  )
}

function SidebarFilterDropdown({
  anchorRect,
  onClose
}: {
  anchorRect: DOMRect
  onClose: () => void
}): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const sidebarFilter = useAppStore((s) => s.sidebarFilter)
  const setSidebarFilterBase = useAppStore((s) => s.setSidebarFilterBase)
  const toggleColor = useAppStore((s) => s.toggleSidebarFilterColor)
  const toggleWorkspace = useAppStore((s) => s.toggleSidebarFilterWorkspace)
  const toggleRunning = useAppStore((s) => s.toggleSidebarFilterRunning)
  const toggleJustDone = useAppStore((s) => s.toggleSidebarFilterJustDone)
  const toggleFolderOnly = useAppStore((s) => s.toggleSidebarFilterFolderOnly)
  const clearFilter = useAppStore((s) => s.clearSidebarFilter)
  const workspaces = useWorkspaceFilterOptions()
  const hasMulti = hasActiveMultiFilter(sidebarFilter)
  const hasAnyFilter = hasMulti || sidebarFilter.base === 'archived'

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

  const menuWidth = 220
  const menuHeight = Math.min(360, Math.max(220, window.innerHeight - anchorRect.bottom - 24))
  const left = Math.max(
    12,
    Math.min(
      anchorRect.left + anchorRect.width / 2 - menuWidth / 2,
      window.innerWidth - menuWidth - 12
    )
  )

  return createPortal(
    <div
      ref={menuRef}
      onMouseDown={(e) => e.stopPropagation()}
      className="no-drag"
      style={{
        position: 'fixed',
        top: anchorRect.bottom + 6,
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
        height: menuHeight,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(-4px)',
        transition: 'opacity 0.15s ease, transform 0.15s ease'
      }}
    >
      {/* Base filter (radio) */}
      <div style={{ opacity: hasMulti ? 0.35 : 1, pointerEvents: hasMulti ? 'none' : 'auto' }}>
        <RadioRow
          label="All"
          checked={sidebarFilter.base === 'all'}
          onClick={() => setSidebarFilterBase('all')}
        />
        <RadioRow
          label="Archived"
          checked={sidebarFilter.base === 'archived'}
          onClick={() => setSidebarFilterBase('archived')}
        />
      </div>

      <Divider />

      {/* Color tags */}
      <SectionLabel>Color</SectionLabel>
      {THREAD_COLOR_TAGS.map((tag) => (
        <CheckboxRow
          key={tag}
          label={THREAD_COLOR_FILTER_LABELS[tag]}
          checked={sidebarFilter.colorTags.has(tag)}
          onClick={() => toggleColor(tag)}
          swatch={THREAD_COLOR_VALUES[tag]}
        />
      ))}

      {/* Workspace paths */}
      {workspaces.length > 0 && (
        <>
          <SectionLabel>Workspace</SectionLabel>
          {workspaces.map((ws) => (
            <CheckboxRow
              key={ws.path}
              label={ws.displayName}
              checked={sidebarFilter.workspacePaths.has(ws.path)}
              onClick={() => toggleWorkspace(ws.path)}
              title={ws.path === TEMPORARY_WORKSPACE_FILTER ? undefined : ws.path}
            />
          ))}
        </>
      )}

      {/* Status filters */}
      <SectionLabel>Status</SectionLabel>
      <CheckboxRow label="Running" checked={sidebarFilter.running} onClick={toggleRunning} />
      <CheckboxRow label="Just Done" checked={sidebarFilter.justDone} onClick={toggleJustDone} />
      <CheckboxRow
        label="Folder-Only"
        checked={sidebarFilter.folderOnly}
        onClick={toggleFolderOnly}
      />

      {/* Clear */}
      {hasAnyFilter && (
        <>
          <Divider />
          <button
            onClick={() => {
              clearFilter()
              onClose()
            }}
            className="w-full flex items-center gap-2 rounded-lg px-3 py-1.5 text-left transition-colors"
            style={{ color: theme.text.accent, fontSize: '12px', fontWeight: 500 }}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLElement).style.background = theme.background.hoverStrong
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLElement).style.background = 'transparent'
            }}
          >
            <X size={12} strokeWidth={2} />
            Clear filters
          </button>
        </>
      )}
    </div>,
    document.body
  )
}

function RadioRow({
  label,
  checked,
  onClick
}: {
  label: string
  checked: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13px] transition-colors"
      style={{ color: checked ? theme.text.accentStrong : theme.text.primary }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLElement).style.background = theme.background.hoverStrong
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLElement).style.background = 'transparent'
      }}
    >
      <span
        className="flex items-center justify-center shrink-0 rounded-full"
        style={{
          width: 14,
          height: 14,
          border: `1.5px solid ${checked ? theme.text.accentStrong : alpha('ink', 0.25)}`
        }}
      >
        {checked && (
          <span
            className="rounded-full"
            style={{
              width: 7,
              height: 7,
              background: theme.text.accentStrong
            }}
          />
        )}
      </span>
      {label}
    </button>
  )
}

function CheckboxRow({
  label,
  checked,
  onClick,
  swatch,
  title
}: {
  label: string
  checked: boolean
  onClick: () => void
  swatch?: string
  title?: string
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-full flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-[13px] transition-colors"
      style={{ color: checked ? theme.text.accentStrong : theme.text.primary }}
      onMouseEnter={(e) => {
        ;(e.currentTarget as HTMLElement).style.background = theme.background.hoverStrong
      }}
      onMouseLeave={(e) => {
        ;(e.currentTarget as HTMLElement).style.background = 'transparent'
      }}
    >
      <span
        className="flex items-center justify-center shrink-0 rounded"
        style={{
          width: 14,
          height: 14,
          border: `1.5px solid ${checked ? theme.text.accentStrong : alpha('ink', 0.25)}`,
          background: checked ? theme.text.accentStrong : 'transparent'
        }}
      >
        {checked && <Check size={10} strokeWidth={3} style={{ color: '#fff' }} />}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {swatch && (
        <span
          className="shrink-0 rounded-full"
          style={{ width: 8, height: 8, background: swatch }}
        />
      )}
    </button>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="px-3 pt-2 pb-0.5"
      style={{
        fontSize: '0.65rem',
        fontWeight: 600,
        color: theme.text.muted,
        letterSpacing: '0.04em',
        textTransform: 'uppercase'
      }}
    >
      {children}
    </div>
  )
}

function Divider(): React.JSX.Element {
  return <div className="mx-2 my-1" style={{ height: 1, background: theme.border.panel }} />
}
