import type React from 'react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Archive, FolderPlus, RotateCcw, Sparkles, Trash2, X } from 'lucide-react'
import { useVirtualizer as useTanStackVirtualizer } from '@tanstack/react-virtual'
import { useShallow } from 'zustand/react/shallow'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent
} from '@dnd-kit/core'
import { useAppStore, hasActiveMultiFilter } from '@renderer/app/store/useAppStore'
import type { FolderRecord, RunRecord, Thread, ThreadColorTag, ToolCall } from '@renderer/app/types'
import type { ThreadContextOperationKey } from '@renderer/features/threads/lib/threadContextOperations'
import {
  resolveBackgroundTaskHydrationThreadIds,
  resolveVisibleSidebarThreads
} from '@renderer/features/threads/lib/threadListFilters'
import { ThreadFolderItem } from './ThreadFolderItem'
import { ThreadListItem } from './ThreadListItem'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { theme } from '@renderer/theme/theme'
import { isMemoryConfigured } from '../../../../../shared/yachiyo/protocol.ts'
import { resolveThreadColor } from '@renderer/features/threads/lib/threadColorPalette'
import {
  buildSidebarItems,
  buildSidebarRows,
  estimateSidebarRowSize,
  FOLDER_VIEWPORT_MAX_HEIGHT,
  resolveSidebarFolderDropId,
  type SidebarRow
} from '@renderer/features/threads/lib/threadSidebarRows'
import {
  selectRunningBackgroundTaskThreadIds,
  useBackgroundTasksStore
} from '@renderer/features/chat/state/useBackgroundTasksStore'

const BACKGROUND_TASK_SIDEBAR_HYDRATE_INTERVAL_MS = 15_000
const EMPTY_WORKSPACE_PATHS: string[] = []
const EMPTY_THREAD_TOOL_CALLS: ToolCall[] = []
const useSidebarVirtualizer = useTanStackVirtualizer

function DraggableThread({
  thread,
  children
}: {
  thread: Thread
  children: React.ReactNode
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `thread-${thread.id}`,
    data: { type: 'thread', thread }
  })

  // Wrap pointer-down to skip right-clicks and clicks originating from portaled menus
  const guardedListeners = listeners
    ? {
        ...listeners,
        onPointerDown: (e: React.PointerEvent) => {
          // Skip right-click (context menu trigger)
          if (e.button !== 0) return
          // Skip if a fixed/portaled overlay is currently in the DOM at the click point
          const els = document.elementsFromPoint(e.clientX, e.clientY)
          if (els.some((el) => el.closest('[data-no-drag]'))) return
          listeners.onPointerDown?.(e)
        }
      }
    : undefined

  return (
    <div
      ref={setNodeRef}
      {...guardedListeners}
      {...attributes}
      style={{ opacity: isDragging ? 0.4 : 1 }}
    >
      {children}
    </div>
  )
}

function DroppableFolder({
  folderId,
  dropId,
  children
}: {
  folderId: string
  dropId?: string
  children: React.ReactNode
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: dropId ?? `folder-${folderId}`,
    data: { type: 'folder', folderId }
  })

  return (
    <div
      ref={setNodeRef}
      style={{
        borderRadius: 6,
        outline: isOver ? `2px solid ${theme.border.accent}` : 'none',
        outlineOffset: -2,
        transition: 'outline 0.1s ease'
      }}
    >
      {children}
    </div>
  )
}

function DroppableThread({
  threadId,
  children
}: {
  threadId: string
  children: React.ReactNode
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: `drop-thread-${threadId}`,
    data: { type: 'thread', threadId }
  })

  return (
    <div
      ref={setNodeRef}
      style={{
        borderRadius: 6,
        outline: isOver ? `2px solid ${theme.border.accent}` : 'none',
        outlineOffset: -2,
        transition: 'outline 0.1s ease'
      }}
    >
      {children}
    </div>
  )
}

function FolderAwareThreadList({
  threads,
  folders,
  collapsedFolderIds,
  scrollElement,
  showPreview,
  mode,
  toggleFolderCollapsed,
  renameFolder,
  setFolderColor,
  deleteFolder,
  moveThreadToFolder,
  createFolderForThreads,
  archiveFolder,
  restoreFolder,
  renderThreadItem
}: {
  threads: Thread[]
  folders: FolderRecord[]
  collapsedFolderIds: Set<string>
  scrollElement: HTMLDivElement | null
  showPreview: boolean
  mode: 'active' | 'archived'
  toggleFolderCollapsed: (folderId: string) => void
  renameFolder: (folderId: string, title: string) => Promise<void>
  setFolderColor: (folderId: string, colorTag: string | null) => Promise<void>
  deleteFolder: (folderId: string) => Promise<void>
  moveThreadToFolder: (threadId: string, folderId: string | null) => Promise<void>
  createFolderForThreads: (threadIds: string[]) => Promise<void>
  archiveFolder: (folder: FolderRecord, threads: Thread[]) => void
  restoreFolder: (folder: FolderRecord, threads: Thread[]) => void
  renderThreadItem: (thread: Thread, options?: { isInFolder?: boolean }) => React.JSX.Element
}): React.JSX.Element {
  const items = useMemo(() => buildSidebarItems(threads, folders), [threads, folders])
  const rows = useMemo(
    () => buildSidebarRows(items, collapsedFolderIds),
    [items, collapsedFolderIds]
  )
  const [draggedThread, setDraggedThread] = useState<Thread | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const getScrollElement = useCallback(() => scrollElement, [scrollElement])
  const estimateSize = useCallback(
    (index: number) => estimateSidebarRowSize(rows[index]!, showPreview),
    [rows, showPreview]
  )
  const getItemKey = useCallback((index: number) => rows[index]!.key, [rows])
  const virtualizer = useSidebarVirtualizer({
    count: rows.length,
    getScrollElement,
    estimateSize,
    overscan: 10,
    getItemKey
  })

  useLayoutEffect(() => {
    if (!scrollElement) return

    virtualizer.scrollToOffset(0)
    virtualizer.measure()
  }, [mode, rows.length, scrollElement, threads.length, virtualizer])

  useLayoutEffect(() => {
    virtualizer.measure()
  }, [collapsedFolderIds, virtualizer])

  function handleDragEnd(event: DragEndEvent): void {
    setDraggedThread(null)
    const { active, over } = event

    const activeData = active.data.current as { type: string; thread: Thread } | undefined
    if (!activeData || activeData.type !== 'thread') return

    // Dropped on empty space — remove from folder if applicable
    if (!over) {
      if (activeData.thread.folderId) {
        void moveThreadToFolder(activeData.thread.id, null)
      }
      return
    }

    const overData = over.data.current as
      | { type: string; folderId?: string; threadId?: string }
      | undefined

    if (overData?.type === 'folder' && overData.folderId) {
      void moveThreadToFolder(activeData.thread.id, overData.folderId)
    } else if (
      overData?.type === 'thread' &&
      overData.threadId &&
      overData.threadId !== activeData.thread.id
    ) {
      // Drop thread on another loose thread → create a folder for both
      void createFolderForThreads([overData.threadId, activeData.thread.id])
    } else if (activeData.thread.folderId) {
      // Dropped on a non-folder/non-thread target (e.g. date header) — remove from folder
      void moveThreadToFolder(activeData.thread.id, null)
    }
  }

  function renderFolderChildRow(
    row: Extract<SidebarRow, { kind: 'folder-date-header' | 'folder-thread' }>
  ): React.JSX.Element {
    const lineColor = row.folder.colorTag
      ? resolveThreadColor(row.folder.colorTag, theme.text.secondary)
      : theme.border.default

    const childRow = (
      <div className="relative" style={{ marginLeft: 15, paddingLeft: 12 }}>
        <div
          className="absolute left-0 top-0 bottom-0"
          style={{
            width: 1,
            background: lineColor,
            opacity: row.folder.colorTag ? 0.4 : 1
          }}
        />
        {row.kind === 'folder-date-header' ? (
          <div
            className="px-2 pt-1.5 pb-0.5"
            style={{
              fontSize: '0.6rem',
              fontWeight: 500,
              color: theme.text.muted,
              letterSpacing: '0.03em'
            }}
          >
            {row.label}
          </div>
        ) : mode === 'archived' ? (
          <div>{renderThreadItem(row.thread, { isInFolder: true })}</div>
        ) : (
          <DraggableThread thread={row.thread}>
            {renderThreadItem(row.thread, { isInFolder: true })}
          </DraggableThread>
        )}
      </div>
    )

    if (mode === 'archived') return childRow

    return (
      <DroppableFolder folderId={row.folder.id} dropId={resolveSidebarFolderDropId(row)}>
        {childRow}
      </DroppableFolder>
    )
  }

  function renderSidebarRow(row: SidebarRow): React.JSX.Element {
    if (row.kind === 'starred-header') {
      return (
        <div
          className="px-3 pt-2 pb-1"
          style={{
            fontSize: '0.7rem',
            fontWeight: 600,
            color: theme.text.muted,
            letterSpacing: '0.04em',
            textTransform: 'uppercase'
          }}
        >
          Starred
        </div>
      )
    }

    if (row.kind === 'date-header') {
      return (
        <div
          className="px-3 pt-2 pb-1"
          style={{
            fontSize: '0.7rem',
            fontWeight: 500,
            color: theme.text.muted
          }}
        >
          {row.label}
        </div>
      )
    }

    if (row.kind === 'thread') {
      const threadNode = renderThreadItem(row.thread)
      if (mode === 'archived') {
        return <div>{threadNode}</div>
      }
      return (
        <DroppableThread threadId={row.thread.id}>
          <DraggableThread thread={row.thread}>{threadNode}</DraggableThread>
        </DroppableThread>
      )
    }

    if (row.kind === 'folder') {
      const isCollapsed = collapsedFolderIds.has(row.folder.id)
      const folderThreads = row.threads
      const folderNode = (
        <ThreadFolderItem
          folder={row.folder}
          isCollapsed={isCollapsed}
          threadCount={folderThreads.length}
          mode={mode}
          onToggle={() => toggleFolderCollapsed(row.folder.id)}
          onRename={(title) => void renameFolder(row.folder.id, title)}
          onSetColor={(colorTag) => void setFolderColor(row.folder.id, colorTag)}
          onDelete={() => void deleteFolder(row.folder.id)}
          onArchiveAll={() => archiveFolder(row.folder, folderThreads)}
          onRestoreAll={() => restoreFolder(row.folder, folderThreads)}
        />
      )

      const lineColor = row.folder.colorTag
        ? resolveThreadColor(row.folder.colorTag, theme.text.secondary)
        : theme.border.default
      const lineOpacity = row.folder.colorTag ? 0.4 : 1

      const childrenContent = !isCollapsed && row.children.length > 0 && (
        <div
          style={{
            maxHeight: FOLDER_VIEWPORT_MAX_HEIGHT,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            scrollbarWidth: 'none',
            maskImage: 'linear-gradient(to bottom, black calc(100% - 16px), transparent)',
            WebkitMaskImage: 'linear-gradient(to bottom, black calc(100% - 16px), transparent)'
          }}
        >
          <div className="relative" style={{ marginLeft: 15, paddingLeft: 12, paddingBottom: 4 }}>
            <div
              className="absolute left-0 top-0 bottom-0"
              style={{ width: 1, background: lineColor, opacity: lineOpacity }}
            />
            {row.children.map((child) => {
              if (child.kind === 'folder-date-header') {
                return (
                  <div
                    key={`fdate:${child.label}`}
                    className="px-2 pt-1.5 pb-0.5"
                    style={{
                      fontSize: '0.6rem',
                      fontWeight: 500,
                      color: theme.text.muted,
                      letterSpacing: '0.03em'
                    }}
                  >
                    {child.label}
                  </div>
                )
              }
              const threadNode = renderThreadItem(child.thread, { isInFolder: true })
              if (mode === 'archived') {
                return <div key={child.thread.id}>{threadNode}</div>
              }
              return (
                <DroppableFolder
                  key={child.thread.id}
                  folderId={row.folder.id}
                  dropId={`folder-${row.folder.id}-child-${child.thread.id}`}
                >
                  <DraggableThread thread={child.thread}>{threadNode}</DraggableThread>
                </DroppableFolder>
              )
            })}
          </div>
        </div>
      )

      if (mode === 'archived') {
        return (
          <div>
            {folderNode}
            {childrenContent}
          </div>
        )
      }
      return (
        <DroppableFolder folderId={row.folder.id} dropId={resolveSidebarFolderDropId(row)}>
          {folderNode}
          {childrenContent}
        </DroppableFolder>
      )
    }

    return renderFolderChildRow(row)
  }

  const virtualizedRows = (
    <div
      style={{
        height: virtualizer.getTotalSize(),
        width: '100%',
        position: 'relative'
      }}
    >
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index]
        if (!row) return null

        return (
          <div
            key={row.key}
            data-index={virtualRow.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${virtualRow.start}px)`,
              contain: 'content'
            }}
          >
            {renderSidebarRow(row)}
          </div>
        )
      })}
    </div>
  )

  if (mode === 'archived') {
    return virtualizedRows
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(event) => {
        const data = event.active.data.current as { type: string; thread: Thread } | undefined
        if (data?.type === 'thread') setDraggedThread(data.thread)
      }}
      onDragEnd={handleDragEnd}
    >
      {virtualizedRows}
      <DragOverlay>
        {draggedThread ? (
          <div
            className="rounded-md px-3 py-2 text-sm shadow-lg"
            style={{
              background: theme.background.surface,
              border: `1px solid ${theme.border.panel}`,
              color: theme.text.primary,
              maxWidth: 240,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {draggedThread.title}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

function ThreadListEmpty({
  threadListMode
}: {
  threadListMode: 'active' | 'archived'
}): React.JSX.Element {
  const sidebarFilter = useAppStore((s) => s.sidebarFilter)
  const clearFilter = useAppStore((s) => s.clearSidebarFilter)
  const hasFilter = hasActiveMultiFilter(sidebarFilter) || sidebarFilter.base === 'archived'

  if (hasFilter) {
    return (
      <div className="px-4 py-6 text-sm leading-6" style={{ color: theme.text.muted }}>
        No threads match the current filter.
        <br />
        <button
          onClick={clearFilter}
          className="mt-1"
          style={{
            color: theme.text.accent,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            fontSize: 'inherit'
          }}
        >
          Clear filters
        </button>
      </div>
    )
  }

  return (
    <div className="px-4 py-6 text-sm leading-6" style={{ color: theme.text.muted }}>
      {threadListMode === 'archived'
        ? 'No archived threads yet.'
        : 'No chats yet. Start one from the compose box or the new chat button.'}
    </div>
  )
}

function ThreadListContent({
  activeId,
  archiveThread,
  cancelRunForThread,
  compactThreadToAnotherThread,
  deleteThread,
  latestRunsByThread,
  memoryEnabled,
  regenerateThreadTitle,
  renameThread,
  restoreThread,
  saveThread,
  savingThreadIds,
  backgroundTaskRunningThreadIds,
  setActiveArchivedThread,
  setActiveThread,
  setThreadColor,
  setThreadIcon,
  starThread,
  threadListMode,
  visibleThreads,
  toolCallsByThread,
  folders,
  collapsedFolderIds,
  toggleFolderCollapsed,
  renameFolder,
  setFolderColor,
  deleteFolder,
  moveThreadToFolder,
  createFolderForThreads
}: {
  activeId: string | null
  archiveThread: (threadId: string) => Promise<void>
  cancelRunForThread: (threadId: string) => Promise<void>
  compactThreadToAnotherThread: () => Promise<void>
  deleteThread: (threadId: string) => Promise<void>
  latestRunsByThread: Record<string, RunRecord>
  memoryEnabled: boolean
  regenerateThreadTitle: (threadId: string) => Promise<void>
  renameThread: (threadId: string, title: string) => Promise<void>
  restoreThread: (threadId: string) => Promise<void>
  saveThread: (threadId: string, options: { archiveAfterSave: boolean }) => Promise<void>
  savingThreadIds: Set<string>
  backgroundTaskRunningThreadIds: ReadonlySet<string>
  setActiveArchivedThread: (threadId: string) => void
  setActiveThread: (threadId: string) => void
  setThreadColor: (threadId: string, colorTag: ThreadColorTag | null) => Promise<void>
  setThreadIcon: (threadId: string, icon: string | null) => Promise<void>
  starThread: (threadId: string, starred: boolean) => Promise<void>
  threadListMode: 'active' | 'archived'
  visibleThreads: Thread[]
  toolCallsByThread: Record<string, ToolCall[]>
  folders: FolderRecord[]
  collapsedFolderIds: Set<string>
  toggleFolderCollapsed: (folderId: string) => void
  renameFolder: (folderId: string, title: string) => Promise<void>
  setFolderColor: (folderId: string, colorTag: string | null) => Promise<void>
  deleteFolder: (folderId: string) => Promise<void>
  moveThreadToFolder: (threadId: string, folderId: string | null) => Promise<void>
  createFolderForThreads: (threadIds: string[]) => Promise<void>
}): React.JSX.Element {
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [archiveTarget, setArchiveTarget] = useState<Thread | null>(null)
  const [bulkArchiveIds, setBulkArchiveIds] = useState<string[] | null>(null)
  const [folderArchiveTarget, setFolderArchiveTarget] = useState<{
    folder: FolderRecord
    threads: Thread[]
  } | null>(null)
  const [folderRestoreTarget, setFolderRestoreTarget] = useState<{
    folder: FolderRecord
    threads: Thread[]
  } | null>(null)
  const runStatusesByThread = useAppStore((s) => s.runStatusesByThread)
  const justDoneRunIdsByThread = useAppStore((s) => s.justDoneRunIdsByThread)
  const showPreview = useAppStore((s) => s.config?.general?.sidebarPreview) !== false
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const setScrollNode = useCallback((node: HTMLDivElement | null) => {
    setScrollElement((current) => (current === node ? current : node))
  }, [])

  function exitSelectMode(): void {
    setSelectMode(false)
    setSelectedIds(new Set())
  }

  useEffect(() => {
    if (!selectMode) return
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') exitSelectMode()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selectMode])

  function toggleSelection(threadId: string): void {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(threadId)) {
        next.delete(threadId)
      } else {
        next.add(threadId)
      }
      return next
    })
  }

  async function handleSelectOperation(
    thread: Thread,
    operationKey: ThreadContextOperationKey
  ): Promise<void> {
    try {
      if (operationKey === 'enter-select-mode') {
        setSelectMode(true)
        setSelectedIds(new Set([thread.id]))
        return
      }

      if (operationKey === 'regenerate-title') {
        await regenerateThreadTitle(thread.id)
        return
      }

      if (operationKey === 'star' || operationKey === 'unstar') {
        await starThread(thread.id, operationKey === 'star')
        return
      }

      if (operationKey === 'archive') {
        setArchiveTarget(thread)
        return
      }

      if (operationKey === 'compact-to-another-thread') {
        setActiveThread(thread.id)
        await compactThreadToAnotherThread()
        return
      }

      if (operationKey === 'remove-from-folder') {
        await moveThreadToFolder(thread.id, null)
        return
      }

      if (operationKey === 'create-folder') {
        await createFolderForThreads([thread.id])
        return
      }

      if (operationKey === 'restore') {
        await restoreThread(thread.id)
        return
      }

      if (latestRunsByThread[thread.id]?.status === 'running') {
        if (!window.confirm(`"${thread.title}" has an active run. Cancel the run and delete?`)) {
          return
        }
        await cancelRunForThread(thread.id)
        await deleteThread(thread.id)
        return
      }
      if (window.confirm(`Delete "${thread.title}" permanently?`)) {
        await deleteThread(thread.id)
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to update the thread.')
    }
  }

  async function handleBulkArchive(): Promise<void> {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    setBulkArchiveIds(ids)
  }

  async function handleBulkArchiveConfirm(choice: string): Promise<void> {
    if (choice !== 'archive' || !bulkArchiveIds) {
      setBulkArchiveIds(null)
      return
    }

    const ids = bulkArchiveIds
    setBulkArchiveIds(null)

    try {
      for (const id of ids) {
        await archiveThread(id)
      }
      exitSelectMode()
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to archive threads.')
    }
  }

  async function handleBulkRestore(): Promise<void> {
    const ids = [...selectedIds]
    if (!window.confirm(`Restore ${ids.length} thread${ids.length !== 1 ? 's' : ''}?`)) return
    try {
      for (const id of ids) {
        await restoreThread(id)
      }
      exitSelectMode()
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to restore threads.')
    }
  }

  async function handleBulkDelete(): Promise<void> {
    const ids = [...selectedIds]
    if (!window.confirm(`Delete ${ids.length} thread${ids.length !== 1 ? 's' : ''} permanently?`))
      return
    try {
      for (const id of ids) {
        await deleteThread(id)
      }
      exitSelectMode()
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to delete threads.')
    }
  }

  async function handleBulkRegenerateTitle(): Promise<void> {
    const ids = [...selectedIds]
    try {
      for (const id of ids) {
        await regenerateThreadTitle(id)
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to regenerate thread titles.')
    }
  }

  async function handleRename(thread: Thread, nextTitle: string): Promise<void> {
    try {
      await renameThread(thread.id, nextTitle)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to rename the thread.')
    }
  }

  async function handleSetIcon(thread: Thread, icon: string | null): Promise<void> {
    try {
      await setThreadIcon(thread.id, icon)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to update the thread icon.')
    }
  }

  async function handleSetThreadColor(
    thread: Thread,
    colorTag: ThreadColorTag | null
  ): Promise<void> {
    try {
      await setThreadColor(thread.id, colorTag)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to update the thread color.')
    }
  }

  async function handleStar(thread: Thread): Promise<void> {
    try {
      await starThread(thread.id, !thread.starredAt)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to update the thread.')
    }
  }

  function dropSelectionIds(ids: string[]): void {
    if (ids.length === 0) return
    setSelectedIds((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const id of ids) {
        if (next.delete(id)) changed = true
      }
      return changed ? next : prev
    })
  }

  async function handleFolderArchiveConfirm(choice: string): Promise<void> {
    const target = folderArchiveTarget
    setFolderArchiveTarget(null)
    if (choice !== 'archive' || !target) return
    try {
      for (const thread of target.threads) {
        await archiveThread(thread.id)
      }
      dropSelectionIds(target.threads.map((t) => t.id))
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to archive folder threads.')
    }
  }

  async function handleFolderRestoreConfirm(choice: string): Promise<void> {
    const target = folderRestoreTarget
    setFolderRestoreTarget(null)
    if (choice !== 'restore' || !target) return
    try {
      for (const thread of target.threads) {
        await restoreThread(thread.id)
      }
      dropSelectionIds(target.threads.map((t) => t.id))
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to restore folder threads.')
    }
  }

  async function handleArchiveConfirm(choice: string): Promise<void> {
    if (!archiveTarget) return
    const thread = archiveTarget
    setArchiveTarget(null)

    try {
      if (choice === 'archive') {
        await archiveThread(thread.id)
      } else if (choice === 'save-and-archive') {
        if (savingThreadIds.has(thread.id)) return
        await saveThread(thread.id, { archiveAfterSave: true })
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to archive the thread.')
    }
  }

  function renderThreadItem(
    thread: Thread,
    options: { isInFolder?: boolean } = {}
  ): React.JSX.Element {
    const isRunActive = runStatusesByThread[thread.id] === 'running'
    const hasBackgroundWork = backgroundTaskRunningThreadIds.has(thread.id)

    return (
      <ThreadListItem
        key={thread.id}
        thread={thread}
        activeRunId={isRunActive ? (latestRunsByThread[thread.id]?.id ?? null) : null}
        isActive={thread.id === activeId}
        hasActiveRun={isRunActive || hasBackgroundWork}
        hasBackgroundWork={hasBackgroundWork}
        hasJustDoneRun={threadListMode === 'active' && Boolean(justDoneRunIdsByThread[thread.id])}
        isRunActive={isRunActive}
        isSaving={savingThreadIds.has(thread.id)}
        isSelectMode={selectMode}
        isSelected={selectedIds.has(thread.id)}
        isStarred={!!thread.starredAt}
        isInFolder={options.isInFolder === true}
        showPreview={showPreview}
        toolCalls={toolCallsByThread[thread.id] ?? EMPTY_THREAD_TOOL_CALLS}
        threadListMode={threadListMode}
        onRename={(targetThread, nextTitle) => void handleRename(targetThread, nextTitle)}
        onSelectOperation={(targetThread, operationKey) =>
          void handleSelectOperation(targetThread, operationKey)
        }
        onSelectThread={(threadId) => {
          if (threadListMode === 'archived') {
            setActiveArchivedThread(threadId)
            return
          }
          setActiveThread(threadId)
        }}
        onSetIcon={(targetThread, icon) => void handleSetIcon(targetThread, icon)}
        onSetThreadColor={(targetThread, colorTag) =>
          void handleSetThreadColor(targetThread, colorTag)
        }
        onStar={(targetThread) => void handleStar(targetThread)}
        onToggleSelect={toggleSelection}
      />
    )
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div
        style={{
          display: 'grid',
          gridTemplateRows: selectMode ? '1fr' : '0fr',
          opacity: selectMode ? 1 : 0,
          transition: 'grid-template-rows 0.2s ease, opacity 0.15s ease'
        }}
      >
        <div className="overflow-hidden">
          <div
            className="flex items-center gap-1.5 mx-2 mt-1 mb-0.5 px-3 py-2 rounded-lg"
            style={{ background: theme.background.code }}
          >
            <span className="flex-1 text-xs" style={{ color: theme.text.secondary }}>
              {selectedIds.size === 0 ? 'Select threads' : `${selectedIds.size} selected`}
            </span>
            {selectedIds.size > 0 ? (
              <button
                title="Regenerate titles"
                onClick={() => void handleBulkRegenerateTitle()}
                className="flex items-center justify-center rounded p-1 transition-colors"
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = theme.background.hoverStrong)
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = 'transparent')
                }
              >
                <Sparkles size={13} strokeWidth={1.8} style={{ color: theme.text.secondary }} />
              </button>
            ) : null}
            {selectedIds.size >= 2 && threadListMode === 'active' ? (
              <button
                title="Create folder from selected"
                onClick={() => {
                  void createFolderForThreads([...selectedIds])
                  setSelectMode(false)
                  setSelectedIds(new Set())
                }}
                className="flex items-center justify-center rounded p-1 transition-colors"
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = theme.background.hoverStrong)
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = 'transparent')
                }
              >
                <FolderPlus size={13} strokeWidth={1.8} style={{ color: theme.text.secondary }} />
              </button>
            ) : null}
            {selectedIds.size > 0 && threadListMode === 'active' ? (
              <button
                title="Archive selected"
                onClick={() => void handleBulkArchive()}
                className="flex items-center justify-center rounded p-1 transition-colors"
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = theme.background.hoverStrong)
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = 'transparent')
                }
              >
                <Archive size={13} strokeWidth={1.8} style={{ color: theme.text.secondary }} />
              </button>
            ) : null}
            {selectedIds.size > 0 && threadListMode === 'archived' ? (
              <button
                title="Restore selected"
                onClick={() => void handleBulkRestore()}
                className="flex items-center justify-center rounded p-1 transition-colors"
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = theme.background.hoverStrong)
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = 'transparent')
                }
              >
                <RotateCcw size={13} strokeWidth={1.8} style={{ color: theme.text.secondary }} />
              </button>
            ) : null}
            {selectedIds.size > 0 ? (
              <button
                title="Delete selected"
                onClick={() => void handleBulkDelete()}
                className="flex items-center justify-center rounded p-1 transition-colors"
                onMouseEnter={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = theme.background.hoverStrong)
                }
                onMouseLeave={(e) =>
                  ((e.currentTarget as HTMLElement).style.background = 'transparent')
                }
              >
                <Trash2 size={13} strokeWidth={1.8} style={{ color: theme.text.dangerStrong }} />
              </button>
            ) : null}
            <button
              title="Exit select mode"
              onClick={exitSelectMode}
              className="flex items-center justify-center rounded p-1 transition-colors"
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLElement).style.background = theme.background.hoverStrong)
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLElement).style.background = 'transparent')
              }
            >
              <X size={13} strokeWidth={1.8} style={{ color: theme.text.secondary }} />
            </button>
          </div>
        </div>
      </div>
      <div
        key={threadListMode}
        ref={setScrollNode}
        className="flex-1 overflow-y-auto px-2 py-1 yachiyo-thread-enter"
      >
        {visibleThreads.length === 0 ? <ThreadListEmpty threadListMode={threadListMode} /> : null}
        <FolderAwareThreadList
          threads={visibleThreads}
          folders={folders}
          collapsedFolderIds={collapsedFolderIds}
          scrollElement={scrollElement}
          showPreview={showPreview}
          mode={threadListMode}
          toggleFolderCollapsed={toggleFolderCollapsed}
          renameFolder={renameFolder}
          setFolderColor={setFolderColor}
          deleteFolder={deleteFolder}
          moveThreadToFolder={moveThreadToFolder}
          createFolderForThreads={createFolderForThreads}
          archiveFolder={(folder, threads) => setFolderArchiveTarget({ folder, threads })}
          restoreFolder={(folder, threads) => setFolderRestoreTarget({ folder, threads })}
          renderThreadItem={renderThreadItem}
        />
      </div>
      {archiveTarget && (
        <ConfirmDialog
          title={`Archive "${archiveTarget.title}"?`}
          actions={[
            { key: 'archive', label: 'Archive', tone: 'accent' },
            ...(memoryEnabled && !archiveTarget.privacyMode
              ? [
                  {
                    key: 'save-and-archive' as const,
                    label: 'Save Memory & Archive' as const
                  }
                ]
              : []),
            { key: 'cancel', label: 'Cancel' }
          ]}
          onSelect={(key) => void handleArchiveConfirm(key)}
          onClose={() => setArchiveTarget(null)}
        />
      )}
      {bulkArchiveIds && (
        <ConfirmDialog
          title={`Archive ${bulkArchiveIds.length} thread${bulkArchiveIds.length !== 1 ? 's' : ''}?`}
          actions={[
            { key: 'archive', label: 'Archive', tone: 'accent' },
            { key: 'cancel', label: 'Cancel' }
          ]}
          onSelect={(key) => void handleBulkArchiveConfirm(key)}
          onClose={() => setBulkArchiveIds(null)}
        />
      )}
      {folderArchiveTarget && (
        <ConfirmDialog
          title={`Archive all ${folderArchiveTarget.threads.length} thread${folderArchiveTarget.threads.length !== 1 ? 's' : ''} in "${folderArchiveTarget.folder.title}"?`}
          actions={[
            { key: 'archive', label: 'Archive', tone: 'accent' },
            { key: 'cancel', label: 'Cancel' }
          ]}
          onSelect={(key) => void handleFolderArchiveConfirm(key)}
          onClose={() => setFolderArchiveTarget(null)}
        />
      )}
      {folderRestoreTarget && (
        <ConfirmDialog
          title={`Restore all ${folderRestoreTarget.threads.length} thread${folderRestoreTarget.threads.length !== 1 ? 's' : ''} in "${folderRestoreTarget.folder.title}"?`}
          actions={[
            { key: 'restore', label: 'Restore', tone: 'accent' },
            { key: 'cancel', label: 'Cancel' }
          ]}
          onSelect={(key) => void handleFolderRestoreConfirm(key)}
          onClose={() => setFolderRestoreTarget(null)}
        />
      )}
    </div>
  )
}

export function ThreadList(): React.JSX.Element {
  const activeArchivedThreadId = useAppStore((s) => s.activeArchivedThreadId)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const archiveThread = useAppStore((s) => s.archiveThread)
  const archivedThreads = useAppStore((s) => s.archivedThreads)
  const compactThreadToAnotherThread = useAppStore((s) => s.compactThreadToAnotherThread)
  const cancelRunForThread = useAppStore((s) => s.cancelRunForThread)
  const deleteThread = useAppStore((s) => s.deleteThread)
  const latestRunsByThread = useAppStore((s) => s.latestRunsByThread)
  const regenerateThreadTitle = useAppStore((s) => s.regenerateThreadTitle)
  const renameThread = useAppStore((s) => s.renameThread)
  const setThreadColor = useAppStore((s) => s.setThreadColor)
  const setThreadIcon = useAppStore((s) => s.setThreadIcon)
  const starThread = useAppStore((s) => s.starThread)
  const folders = useAppStore((s) => s.folders)
  const collapsedFolderIds = useAppStore((s) => s.collapsedFolderIds)
  const toggleFolderCollapsed = useAppStore((s) => s.toggleFolderCollapsed)
  const renameFolderAction = useAppStore((s) => s.renameFolder)
  const setFolderColorAction = useAppStore((s) => s.setFolderColor)
  const deleteFolderAction = useAppStore((s) => s.deleteFolder)
  const moveThreadToFolder = useAppStore((s) => s.moveThreadToFolder)
  const createFolderForThreadsAction = useAppStore((s) => s.createFolderForThreads)
  const restoreThread = useAppStore((s) => s.restoreThread)
  const saveThread = useAppStore((s) => s.saveThread)
  const savingThreadIds = useAppStore((s) => s.savingThreadIds)
  const setActiveArchivedThread = useAppStore((s) => s.setActiveArchivedThread)
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const threadListMode = useAppStore((s) => s.threadListMode)
  const threads = useAppStore((s) => s.threads)
  const toolCallsByThread = useAppStore((s) => s.toolCalls)
  const externalThreads = useAppStore((s) => s.externalThreads)
  const showExternalThreads = useAppStore((s) => s.showExternalThreads)
  const runStatusesByThread = useAppStore((s) => s.runStatusesByThread)
  const backgroundTaskRunningThreadIds = useBackgroundTasksStore(
    useShallow(selectRunningBackgroundTaskThreadIds)
  )
  const justDoneRunIdsByThread = useAppStore((s) => s.justDoneRunIdsByThread)
  const sidebarFilter = useAppStore((s) => s.sidebarFilter)
  const config = useAppStore((s) => s.config)
  const savedWorkspacePaths = config?.workspace?.savedPaths ?? EMPTY_WORKSPACE_PATHS
  const backgroundTaskHydrationThreadIds = useMemo(
    () =>
      resolveBackgroundTaskHydrationThreadIds({
        threads,
        archivedThreads,
        externalThreads
      }),
    [threads, archivedThreads, externalThreads]
  )

  useEffect(() => {
    if (backgroundTaskHydrationThreadIds.length === 0) return

    let cancelled = false
    const hydrate = (): void => {
      void window.api.yachiyo
        .listBackgroundTasks()
        .then((snapshots) => {
          if (cancelled) return
          useBackgroundTasksStore
            .getState()
            .hydrateThreads(backgroundTaskHydrationThreadIds, snapshots)
        })
        .catch((error: unknown) => {
          console.warn('[yachiyo] failed to hydrate sidebar background tasks', error)
        })
    }

    hydrate()
    const intervalId =
      backgroundTaskRunningThreadIds.size > 0
        ? setInterval(hydrate, BACKGROUND_TASK_SIDEBAR_HYDRATE_INTERVAL_MS)
        : undefined

    return () => {
      cancelled = true
      if (intervalId) clearInterval(intervalId)
    }
  }, [backgroundTaskHydrationThreadIds, backgroundTaskRunningThreadIds])

  const visibleThreads = useMemo(
    () =>
      resolveVisibleSidebarThreads({
        threads,
        folders,
        archivedThreads,
        externalThreads,
        showExternalThreads,
        savedWorkspacePaths,
        sidebarFilter,
        threadListMode,
        runStatusesByThread,
        backgroundTaskRunningThreadIds,
        justDoneRunIdsByThread
      }),
    [
      threads,
      folders,
      archivedThreads,
      externalThreads,
      showExternalThreads,
      savedWorkspacePaths,
      sidebarFilter,
      threadListMode,
      runStatusesByThread,
      backgroundTaskRunningThreadIds,
      justDoneRunIdsByThread
    ]
  )
  const activeId = threadListMode === 'archived' ? activeArchivedThreadId : activeThreadId
  const memoryEnabled = isMemoryConfigured(config)

  return (
    <ThreadListContent
      key={threadListMode}
      activeId={activeId}
      archiveThread={archiveThread}
      cancelRunForThread={cancelRunForThread}
      compactThreadToAnotherThread={compactThreadToAnotherThread}
      deleteThread={deleteThread}
      latestRunsByThread={latestRunsByThread}
      memoryEnabled={memoryEnabled}
      regenerateThreadTitle={regenerateThreadTitle}
      renameThread={renameThread}
      restoreThread={restoreThread}
      saveThread={saveThread}
      savingThreadIds={savingThreadIds}
      backgroundTaskRunningThreadIds={backgroundTaskRunningThreadIds}
      setActiveArchivedThread={setActiveArchivedThread}
      setActiveThread={setActiveThread}
      setThreadColor={setThreadColor}
      setThreadIcon={setThreadIcon}
      starThread={starThread}
      threadListMode={threadListMode}
      visibleThreads={visibleThreads}
      toolCallsByThread={toolCallsByThread}
      folders={folders}
      collapsedFolderIds={collapsedFolderIds}
      toggleFolderCollapsed={toggleFolderCollapsed}
      renameFolder={renameFolderAction}
      setFolderColor={setFolderColorAction}
      deleteFolder={deleteFolderAction}
      moveThreadToFolder={moveThreadToFolder}
      createFolderForThreads={createFolderForThreadsAction}
    />
  )
}
