import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import {
  Archive,
  Check,
  CheckCircle2,
  ChevronDown,
  FolderClosed,
  HardDrive,
  Inbox,
  ListFilter,
  LoaderCircle,
  RotateCcw
} from 'lucide-react'
import { DEFAULT_SIDEBAR_FILTER, useAppStore } from '@renderer/app/store/useAppStore'
import { hasActiveMultiFilter, type SidebarFilter } from '@renderer/app/store/useAppStore'
import type { ThreadColorTag } from '@renderer/app/types'
import {
  THREAD_COLOR_FILTER_LABELS,
  THREAD_COLOR_TAGS,
  THREAD_COLOR_VALUES
} from '@renderer/features/threads/lib/threadColorPalette'
import { Tooltip } from '@renderer/components/Tooltip'
import {
  TEMPORARY_WORKSPACE_FILTER,
  resolveWorkspaceDisplayName,
  resolveWorkspaceFilterOptions,
  type WorkspaceFilterOption
} from '@renderer/features/threads/lib/threadWorkspaceFilterOptions'
import { resolveVisibleSidebarThreads } from '@renderer/features/threads/lib/threadListFilters'
import { theme, alpha } from '@renderer/theme/theme'
import {
  selectRunningBackgroundTaskThreadIds,
  useBackgroundTasksStore
} from '@renderer/features/chat/state/useBackgroundTasksStore'

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

function createSidebarFilter(overrides: Partial<SidebarFilter> = {}): SidebarFilter {
  return {
    ...DEFAULT_SIDEBAR_FILTER,
    ...overrides,
    colorTags: overrides.colorTags ?? new Set(),
    workspacePaths: overrides.workspacePaths ?? new Set()
  }
}

function useWorkspaceFilterOptions(): WorkspaceFilterOption[] {
  const threads = useAppStore((s) => s.threads)
  const archivedThreads = useAppStore((s) => s.archivedThreads)
  const savedPaths = useAppStore((s) => s.config?.workspace?.savedPaths ?? EMPTY_WORKSPACE_PATHS)

  return useMemo(
    () => resolveWorkspaceFilterOptions({ savedPaths, threads, archivedThreads }),
    [savedPaths, threads, archivedThreads]
  )
}

function useSidebarFilterCounts(workspaces: WorkspaceFilterOption[]): {
  all: number
  archived: number
  colorTags: Map<ThreadColorTag, number>
  workspacePaths: Map<string, number>
  running: number
  justDone: number
  folderOnly: number
} {
  const threads = useAppStore((s) => s.threads)
  const folders = useAppStore((s) => s.folders)
  const archivedThreads = useAppStore((s) => s.archivedThreads)
  const externalThreads = useAppStore((s) => s.externalThreads)
  const showExternalThreads = useAppStore((s) => s.showExternalThreads)
  const runStatusesByThread = useAppStore((s) => s.runStatusesByThread)
  const backgroundTaskRunningThreadIds = useBackgroundTasksStore(
    useShallow(selectRunningBackgroundTaskThreadIds)
  )
  const justDoneRunIdsByThread = useAppStore((s) => s.justDoneRunIdsByThread)
  const savedWorkspacePaths = useAppStore(
    (s) => s.config?.workspace?.savedPaths ?? EMPTY_WORKSPACE_PATHS
  )

  return useMemo(() => {
    const baseInput = {
      threads,
      folders,
      archivedThreads,
      externalThreads,
      showExternalThreads,
      savedWorkspacePaths,
      runStatusesByThread,
      backgroundTaskRunningThreadIds,
      justDoneRunIdsByThread
    }
    const countActive = (filter: SidebarFilter): number =>
      resolveVisibleSidebarThreads({
        ...baseInput,
        sidebarFilter: filter,
        threadListMode: 'active'
      }).length
    const colorTags = new Map<ThreadColorTag, number>()
    for (const tag of THREAD_COLOR_TAGS) {
      colorTags.set(tag, countActive(createSidebarFilter({ colorTags: new Set([tag]) })))
    }

    return {
      all: countActive(createSidebarFilter()),
      archived: resolveVisibleSidebarThreads({
        ...baseInput,
        sidebarFilter: createSidebarFilter({ base: 'archived' }),
        threadListMode: 'archived'
      }).length,
      colorTags,
      workspacePaths: new Map(workspaces.map((workspace) => [workspace.path, workspace.count])),
      running: countActive(createSidebarFilter({ running: true })),
      justDone: countActive(createSidebarFilter({ justDone: true })),
      folderOnly: countActive(createSidebarFilter({ folderOnly: true }))
    }
  }, [
    threads,
    folders,
    archivedThreads,
    externalThreads,
    showExternalThreads,
    savedWorkspacePaths,
    runStatusesByThread,
    backgroundTaskRunningThreadIds,
    justDoneRunIdsByThread,
    workspaces
  ])
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
  const tooltipLabel = `Filter chats: ${label}`
  const showUnreadDot = unreadArchivedCount > 0 && sidebarFilter.base !== 'archived' && !hasMulti

  return (
    <div className="flex w-full min-w-0 items-center justify-center">
      <Tooltip
        content={
          <span style={{ display: 'block', maxWidth: 240, whiteSpace: 'normal' }}>
            {tooltipLabel}
          </span>
        }
        placement="bottom"
        className="inline-flex max-w-full min-w-0"
      >
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
          className="relative inline-flex max-w-full min-w-0 items-center gap-1.5 px-2.5 py-1 rounded-lg transition-colors"
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
            maxWidth: '100%'
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
          <ListFilter className="shrink-0" size={13} strokeWidth={1.8} />
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown
            className="shrink-0"
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
      </Tooltip>
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
  const unreadArchivedCount = useAppStore(
    (s) => s.archivedThreads.filter((t) => t.archivedAt && !t.readAt).length
  )
  const workspaces = useWorkspaceFilterOptions()
  const counts = useSidebarFilterCounts(workspaces)
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

  const menuWidth = 292
  const minMenuHeight = 320
  const maxMenuHeight = 640
  const availableBelow = window.innerHeight - anchorRect.bottom - 12
  const availableAbove = anchorRect.top - 12
  const openAbove = availableBelow < minMenuHeight && availableAbove > availableBelow
  const menuHeight = Math.min(
    maxMenuHeight,
    Math.max(minMenuHeight, openAbove ? availableAbove : availableBelow)
  )
  const top = openAbove
    ? Math.max(12, anchorRect.top - menuHeight - 6)
    : Math.min(anchorRect.bottom + 6, window.innerHeight - menuHeight - 12)
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
        top,
        left,
        width: menuWidth,
        background: theme.background.surfaceFrosted,
        backdropFilter: 'blur(24px)',
        WebkitBackdropFilter: 'blur(24px)',
        border: `1px solid ${theme.border.strong}`,
        borderRadius: 14,
        boxShadow: theme.shadow.menu,
        zIndex: 120,
        height: menuHeight,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        overscrollBehavior: 'contain',
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(-4px)',
        transition: 'opacity 0.15s ease, transform 0.15s ease'
      }}
    >
      <div
        style={{
          flexShrink: 0,
          padding: 8,
          borderBottom: `1px solid ${theme.border.panel}`,
          background: alpha('surface', 0.78)
        }}
      >
        <div style={{ opacity: hasMulti ? 0.35 : 1, pointerEvents: hasMulti ? 'none' : 'auto' }}>
          <RadioRow
            label="All"
            checked={sidebarFilter.base === 'all'}
            onClick={() => setSidebarFilterBase('all')}
            count={counts.all}
            icon={<Inbox size={15} strokeWidth={1.8} />}
          />
          <RadioRow
            label="Archived"
            checked={sidebarFilter.base === 'archived'}
            onClick={() => setSidebarFilterBase('archived')}
            count={counts.archived}
            unreadCount={unreadArchivedCount}
            icon={<Archive size={15} strokeWidth={1.8} />}
          />
        </div>

        {hasAnyFilter && (
          <button
            onClick={() => {
              clearFilter()
              onClose()
            }}
            className="mt-1 w-full flex min-h-9 items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors"
            style={{ color: theme.text.accent, fontSize: '13px', fontWeight: 600 }}
            onMouseEnter={(e) => {
              ;(e.currentTarget as HTMLElement).style.background = theme.background.hoverStrong
            }}
            onMouseLeave={(e) => {
              ;(e.currentTarget as HTMLElement).style.background = 'transparent'
            }}
          >
            <RotateCcw size={14} strokeWidth={1.8} />
            <span className="flex-1">Reset filters</span>
          </button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 }}>
        <SectionLabel>Status</SectionLabel>
        <CheckboxRow
          label="Running"
          checked={sidebarFilter.running}
          onClick={toggleRunning}
          count={counts.running}
          icon={<LoaderCircle size={15} strokeWidth={1.8} />}
        />
        <CheckboxRow
          label="Just Done"
          checked={sidebarFilter.justDone}
          onClick={toggleJustDone}
          count={counts.justDone}
          icon={<CheckCircle2 size={15} strokeWidth={1.8} />}
        />
        <CheckboxRow
          label="Folder-Only"
          checked={sidebarFilter.folderOnly}
          onClick={toggleFolderOnly}
          count={counts.folderOnly}
          icon={<FolderClosed size={15} strokeWidth={1.8} />}
        />

        <Divider />

        <SectionLabel>Color</SectionLabel>
        {THREAD_COLOR_TAGS.map((tag) => (
          <CheckboxRow
            key={tag}
            label={THREAD_COLOR_FILTER_LABELS[tag]}
            checked={sidebarFilter.colorTags.has(tag)}
            onClick={() => toggleColor(tag)}
            count={counts.colorTags.get(tag)!}
            swatch={THREAD_COLOR_VALUES[tag]}
          />
        ))}

        {workspaces.length > 0 && (
          <>
            <Divider />
            <SectionLabel>Workspace</SectionLabel>
            {workspaces.map((ws) => (
              <CheckboxRow
                key={ws.path}
                label={ws.displayName}
                checked={sidebarFilter.workspacePaths.has(ws.path)}
                onClick={() => toggleWorkspace(ws.path)}
                count={counts.workspacePaths.get(ws.path)!}
                icon={<HardDrive size={15} strokeWidth={1.8} />}
                title={ws.path === TEMPORARY_WORKSPACE_FILTER ? undefined : ws.path}
              />
            ))}
          </>
        )}
      </div>
    </div>,
    document.body
  )
}

function RadioRow({
  label,
  checked,
  onClick,
  count,
  unreadCount,
  icon
}: {
  label: string
  checked: boolean
  onClick: () => void
  count: number
  unreadCount?: number
  icon: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="w-full flex min-h-9 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors"
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
      <span
        className="shrink-0"
        style={{ color: checked ? theme.text.accentStrong : theme.text.muted }}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {unreadCount != null && unreadCount > 0 && <UnreadBadge count={unreadCount} />}
      <CountBadge count={count} active={checked} />
    </button>
  )
}

function CheckboxRow({
  label,
  checked,
  onClick,
  count,
  icon,
  swatch,
  title
}: {
  label: string
  checked: boolean
  onClick: () => void
  count: number
  icon?: React.ReactNode
  swatch?: string
  title?: string
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      className="w-full flex min-h-9 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors"
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
      <span
        className="flex items-center justify-center shrink-0"
        style={{
          width: 16,
          height: 16,
          color: checked ? theme.text.accentStrong : theme.text.muted
        }}
      >
        {swatch ? (
          <span className="rounded-full" style={{ width: 10, height: 10, background: swatch }} />
        ) : (
          icon
        )}
      </span>
      <span className="flex-1 truncate">{label}</span>
      <CountBadge count={count} active={checked} />
    </button>
  )
}

function CountBadge({ count, active }: { count: number; active: boolean }): React.JSX.Element {
  return (
    <span
      className="shrink-0 rounded-full px-1.5 tabular-nums"
      style={{
        minWidth: 22,
        height: 18,
        lineHeight: '18px',
        textAlign: 'center',
        fontSize: '11px',
        fontWeight: 600,
        color: active ? theme.text.accentStrong : theme.text.muted,
        background: active ? theme.background.accentSoft : theme.background.hover
      }}
    >
      {count}
    </span>
  )
}

function UnreadBadge({ count }: { count: number }): React.JSX.Element {
  return (
    <span
      className="shrink-0 rounded-full px-1.5 tabular-nums"
      style={{
        height: 18,
        lineHeight: '18px',
        fontSize: '10.5px',
        fontWeight: 650,
        color: theme.text.accent,
        background: alpha('accent', 0.12)
      }}
    >
      {count} unread
    </span>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      className="px-3 pt-2.5 pb-1"
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
  return <div className="mx-2 my-2" style={{ height: 1, background: theme.border.panel }} />
}
