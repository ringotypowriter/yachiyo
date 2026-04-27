import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, Check, FolderPlus, RotateCcw, Sparkles, Star, Trash2, X } from 'lucide-react'
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
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { FolderRecord, Thread } from '@renderer/app/types'
import { ThreadContextMenuPopup } from '@renderer/features/threads/components/ThreadContextMenuPopup'
import { imeSafeEnter } from '@renderer/lib/imeUtils'
import { stripMarkdown } from '../../../../../shared/yachiyo/messageContent'
import {
  resolveThreadContextOperations,
  type ThreadContextOperationKey
} from '@renderer/features/threads/lib/threadContextOperations'
import {
  canCompactThreadToAnotherThread,
  isExternalThread
} from '@renderer/features/threads/lib/threadVisibility'
import { ThreadFolderItem } from './ThreadFolderItem'
import { ConfirmDialog } from '@renderer/components/ConfirmDialog'
import { theme } from '@renderer/theme/theme'
import { isMemoryConfigured } from '../../../../../shared/yachiyo/protocol.ts'

function extractFirstEmoji(text: string): string | null {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const first = [...segmenter.segment(text.trim())][0]?.segment ?? ''
  return /\p{Extended_Pictographic}/u.test(first) ? first : null
}

const TITLE_DELETE_INTERVAL_MS = 18
const TITLE_TYPE_INTERVAL_MS = 32

function useTitleAnimation(title: string, skip: boolean): string {
  const [displayed, setDisplayed] = useState(title)
  const prevTitleRef = useRef(title)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (title === prevTitleRef.current) return

    const oldTitle = prevTitleRef.current
    const newTitle = title
    prevTitleRef.current = newTitle

    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }

    if (skip) {
      setDisplayed(newTitle)
      return
    }

    let deleteLen = oldTitle.length
    let typeLen = 0

    function step(): void {
      if (deleteLen > 0) {
        deleteLen--
        setDisplayed(oldTitle.slice(0, deleteLen))
        timerRef.current = setTimeout(step, TITLE_DELETE_INTERVAL_MS)
      } else if (typeLen < newTitle.length) {
        typeLen++
        setDisplayed(newTitle.slice(0, typeLen))
        timerRef.current = setTimeout(step, TITLE_TYPE_INTERVAL_MS)
      }
    }

    step()

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [title, skip])

  return displayed
}

function ThreadListItem({
  isActive,
  hasActiveRun,
  isSaving,
  isSelectMode,
  isSelected,
  isStarred,
  onRename,
  onSelectOperation,
  onSelectThread,
  onSetIcon,
  onStar,
  onToggleSelect,
  showPreview,
  thread,
  threadListMode
}: {
  isActive: boolean
  hasActiveRun: boolean
  isSaving: boolean
  isSelectMode: boolean
  isSelected: boolean
  isStarred: boolean
  onRename: (thread: Thread, nextTitle: string) => void
  onSelectOperation: (thread: Thread, operationKey: ThreadContextOperationKey) => void
  onSelectThread: (threadId: string) => void
  onSetIcon: (thread: Thread, icon: string | null) => void
  onStar: (thread: Thread) => void
  onToggleSelect: (threadId: string) => void
  showPreview: boolean
  thread: Thread
  threadListMode: 'active' | 'archived'
}): React.JSX.Element {
  const preview = thread.preview?.trim() ? stripMarkdown(thread.preview.trim()) : 'No messages yet'
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const [renamingTitle, setRenamingTitle] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const iconInputRef = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const isExternal = isExternalThread(thread)
  const operations = resolveThreadContextOperations({
    canHandoff: canCompactThreadToAnotherThread(thread),
    includeSelectMode: true,
    isArchived: threadListMode === 'archived',
    isExternal,
    isInFolder: !!thread.folderId,
    isRunning: hasActiveRun,
    isSaving,
    isStarred
  })

  const displayedTitle = useTitleAnimation(thread.title, renamingTitle)

  const isHighlighted = isSelectMode ? isSelected : isActive
  const isUnreadArchived =
    threadListMode === 'archived' && Boolean(thread.archivedAt) && !thread.readAt

  function handleIconClick(e: React.MouseEvent): void {
    e.stopPropagation()
    e.preventDefault()
    iconInputRef.current?.focus()
    void window.api.yachiyo.showEmojiPanel()
  }

  function handleIconInput(e: React.FormEvent<HTMLInputElement>): void {
    const raw = e.currentTarget.value.trim()
    const newIcon = extractFirstEmoji(raw)
    if (newIcon && newIcon !== thread.icon) {
      onSetIcon(thread, newIcon)
    }
    e.currentTarget.value = ''
  }

  function handleIconInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    e.stopPropagation()
    e.currentTarget.blur()
  }

  function handleTitleInputBlur(e: React.FocusEvent<HTMLInputElement>): void {
    setRenamingTitle(false)
    const nextTitle = e.currentTarget.value.trim()
    if (nextTitle && nextTitle !== thread.title) {
      onRename(thread, nextTitle)
    }
  }

  function handleTitleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRenamingTitle(false)
      return
    }
    imeSafeEnter(() => e.currentTarget.blur())(e)
  }

  function handleClick(): void {
    if (isSelectMode) {
      onToggleSelect(thread.id)
    } else {
      onSelectThread(thread.id)
    }
  }

  function handleSelectOperation(operationKey: ThreadContextOperationKey): void {
    if (operationKey === 'rename') {
      setRenamingTitle(true)
      return
    }
    onSelectOperation(thread, operationKey)
  }

  function openContextMenu(event: React.MouseEvent): void {
    event.preventDefault()
    if (isSelectMode) return
    onSelectThread(thread.id)
    setMenuPosition({
      left: event.clientX,
      top: event.clientY
    })
  }

  return (
    <>
      <div
        className="relative"
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <button
          onClick={handleClick}
          className={`relative w-full text-left px-3 ${showPreview ? 'py-2.5' : 'py-2'} rounded-lg transition-colors no-drag`}
          style={{
            background: isHighlighted ? theme.background.code : 'transparent'
          }}
          onContextMenu={openContextMenu}
          onMouseEnter={(e) => {
            if (!isHighlighted)
              (e.currentTarget as HTMLElement).style.background = theme.background.hover
          }}
          onMouseLeave={(e) => {
            if (!isHighlighted) (e.currentTarget as HTMLElement).style.background = 'transparent'
          }}
        >
          <div className={`flex ${showPreview ? 'items-stretch' : 'items-center'} gap-2 pr-4`}>
            {isSelectMode ? (
              <span
                className="shrink-0 flex items-center"
                style={{ width: '1.45em', fontSize: '1.45em' }}
              >
                <span
                  className="flex items-center justify-center rounded-full"
                  style={{
                    width: 18,
                    height: 18,
                    border: `1.5px solid ${isSelected ? theme.text.accentStrong : theme.border.strong}`,
                    background: isSelected ? theme.text.accentStrong : 'transparent',
                    flexShrink: 0
                  }}
                >
                  {isSelected ? <Check size={10} strokeWidth={3} color="white" /> : null}
                </span>
              </span>
            ) : thread.icon ? (
              <span
                className="relative shrink-0 flex items-center cursor-pointer select-none leading-none"
                style={{ fontSize: showPreview ? '1.45em' : '1.15em' }}
                title="Click to change icon"
              >
                {thread.icon}
                <input
                  ref={iconInputRef}
                  type="text"
                  tabIndex={-1}
                  defaultValue=""
                  onInput={handleIconInput}
                  onKeyDown={handleIconInputKeyDown}
                  onClick={handleIconClick}
                  onMouseDown={(e) => e.stopPropagation()}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                  style={{ fontSize: 'inherit', width: '100%', height: '100%' }}
                />
              </span>
            ) : !showPreview ? (
              <span
                className="shrink-0 flex items-center justify-center"
                style={{ width: 16, height: 16 }}
              >
                <span
                  className="rounded-full"
                  style={{
                    width: 5,
                    height: 5,
                    background: isHighlighted ? theme.text.secondary : theme.text.muted
                  }}
                />
              </span>
            ) : null}
            <div className="min-w-0 flex-1">
              <span
                className={`flex items-center gap-1.5 text-sm ${showPreview ? 'font-medium' : 'font-normal'}`}
                style={{
                  color: isHighlighted
                    ? theme.text.primary
                    : showPreview
                      ? theme.text.secondary
                      : theme.text.primary
                }}
              >
                {renamingTitle ? (
                  <input
                    ref={titleInputRef}
                    autoFocus
                    type="text"
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                    onKeyDown={handleTitleInputKeyDown}
                    onBlur={handleTitleInputBlur}
                    defaultValue={thread.title}
                    className="min-w-0 flex-1 bg-transparent outline-none"
                    style={{
                      color: isHighlighted ? theme.text.primary : theme.text.secondary,
                      fontSize: 'inherit',
                      fontWeight: 'inherit'
                    }}
                  />
                ) : (
                  <span className="min-w-0 flex-1 truncate">{displayedTitle}</span>
                )}
              </span>
              {showPreview && (
                <span
                  className="mt-0.5 block truncate"
                  style={{
                    fontSize: '0.68rem',
                    color: isHighlighted ? theme.text.secondary : theme.text.muted
                  }}
                >
                  {preview}
                </span>
              )}
            </div>
          </div>
          {isSaving ? (
            <span
              aria-label="Saving"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full"
              style={{
                width: '7px',
                height: '7px',
                background: theme.text.muted,
                opacity: isHighlighted ? 1 : 0.8
              }}
            />
          ) : hasActiveRun ? (
            <span
              aria-label="Run active"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full"
              style={{
                width: '7px',
                height: '7px',
                background: theme.text.accentStrong,
                opacity: isHighlighted ? 1 : 0.8
              }}
            />
          ) : isUnreadArchived ? (
            <span
              aria-label="Unread"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full"
              style={{
                width: '8px',
                height: '8px',
                background: theme.text.accent
              }}
            />
          ) : null}
        </button>
        {!isSelectMode && !isUnreadArchived ? (
          <button
            title={isStarred ? 'Unstar' : 'Star'}
            onClick={(e) => {
              e.stopPropagation()
              onStar(thread)
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => {
              e.stopPropagation()
              openContextMenu(e)
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 no-drag"
            style={{
              color: isStarred ? '#f59e0b' : theme.text.muted,
              opacity: !hasActiveRun && !isSaving && (isHovered || isStarred) ? 1 : 0,
              pointerEvents: hasActiveRun || isSaving ? 'none' : 'auto',
              transition: 'opacity 0.15s'
            }}
          >
            <Star
              size={11}
              strokeWidth={isStarred ? 0 : 1.5}
              fill={isStarred ? '#f59e0b' : 'none'}
            />
          </button>
        ) : null}
      </div>
      {menuPosition ? (
        <ThreadContextMenuPopup
          position={menuPosition}
          operations={operations}
          onClose={() => setMenuPosition(null)}
          onSelect={(operationKey) => handleSelectOperation(operationKey)}
        />
      ) : null}
    </>
  )
}

type FolderChild =
  | { kind: 'thread'; thread: Thread }
  | { kind: 'folder-date-header'; label: string }

type SidebarItem =
  | { kind: 'starred-header' }
  | { kind: 'thread'; thread: Thread }
  | { kind: 'folder'; folder: FolderRecord; threads: Thread[]; children: FolderChild[] }
  | { kind: 'date-header'; label: string }

function buildSidebarItems(threads: Thread[], folders: FolderRecord[]): SidebarItem[] {
  const folderMap = new Map<string, FolderRecord>()
  for (const f of folders) folderMap.set(f.id, f)

  // Partition threads
  const starredNoFolder: Thread[] = []
  const folderThreads = new Map<string, Thread[]>()
  const looseThreads: Thread[] = []

  for (const t of threads) {
    if (t.folderId && folderMap.has(t.folderId)) {
      const list = folderThreads.get(t.folderId) ?? []
      list.push(t)
      folderThreads.set(t.folderId, list)
    } else if (t.starredAt) {
      starredNoFolder.push(t)
    } else {
      looseThreads.push(t)
    }
  }

  // Sort folder threads: starred first, then by updatedAt desc
  for (const [fid, fThreads] of folderThreads) {
    fThreads.sort((a, b) => {
      if (a.starredAt && !b.starredAt) return -1
      if (!a.starredAt && b.starredAt) return 1
      return b.updatedAt.localeCompare(a.updatedAt)
    })
    folderThreads.set(fid, fThreads)
  }

  // Build folder items sorted by newest thread's updatedAt
  const folderItems: Array<{
    folder: FolderRecord
    threads: Thread[]
    effectiveUpdatedAt: string
  }> = []
  for (const [fid, fThreads] of folderThreads) {
    const folder = folderMap.get(fid)!
    const maxUpdated = fThreads.reduce((max, t) => (t.updatedAt > max ? t.updatedAt : max), '')
    folderItems.push({ folder, threads: fThreads, effectiveUpdatedAt: maxUpdated })
  }
  folderItems.sort((a, b) => b.effectiveUpdatedAt.localeCompare(a.effectiveUpdatedAt))

  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const result: SidebarItem[] = []

  // 1. Starred section (threads not in any folder)
  if (starredNoFolder.length > 0) {
    result.push({ kind: 'starred-header' })
    for (const t of starredNoFolder) {
      result.push({ kind: 'thread', thread: t })
    }
  }

  // 2. Folders section (own top-level tier, sorted by newest thread)
  for (const fi of folderItems) {
    const children: FolderChild[] = []
    let folderLastLabel = ''
    for (const t of fi.threads) {
      const date = new Date(t.updatedAt)
      const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
      const diffDays = Math.floor((today.getTime() - day.getTime()) / (1000 * 60 * 60 * 24))
      const label =
        diffDays === 0
          ? 'Today'
          : diffDays === 1
            ? 'Yesterday'
            : day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      if (label !== folderLastLabel) {
        children.push({ kind: 'folder-date-header', label })
        folderLastLabel = label
      }
      children.push({ kind: 'thread', thread: t })
    }
    result.push({ kind: 'folder', folder: fi.folder, threads: fi.threads, children })
  }

  // 3. Loose threads, date-grouped
  let lastLabel = ''

  for (const t of looseThreads) {
    const date = new Date(t.updatedAt)
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    const diffDays = Math.floor((today.getTime() - day.getTime()) / (1000 * 60 * 60 * 24))
    const label =
      diffDays === 0
        ? 'Today'
        : diffDays === 1
          ? 'Yesterday'
          : day.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

    if (label !== lastLabel) {
      result.push({ kind: 'date-header', label })
      lastLabel = label
    }
    result.push({ kind: 'thread', thread: t })
  }

  return result
}

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
  children
}: {
  folderId: string
  children: React.ReactNode
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({
    id: `folder-${folderId}`,
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
  mode: 'active' | 'archived'
  toggleFolderCollapsed: (folderId: string) => void
  renameFolder: (folderId: string, title: string) => Promise<void>
  setFolderColor: (folderId: string, colorTag: string | null) => Promise<void>
  deleteFolder: (folderId: string) => Promise<void>
  moveThreadToFolder: (threadId: string, folderId: string | null) => Promise<void>
  createFolderForThreads: (threadIds: string[]) => Promise<void>
  archiveFolder: (folder: FolderRecord, threads: Thread[]) => void
  restoreFolder: (folder: FolderRecord, threads: Thread[]) => void
  renderThreadItem: (thread: Thread) => React.JSX.Element
}): React.JSX.Element {
  const items = useMemo(() => buildSidebarItems(threads, folders), [threads, folders])
  const [draggedThread, setDraggedThread] = useState<Thread | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

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

  const renderedItems = items.map((item) => {
    if (item.kind === 'starred-header') {
      return (
        <div
          key="__starred__"
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

    if (item.kind === 'date-header') {
      return (
        <div
          key={`__date__${item.label}`}
          className="px-3 pt-2 pb-1"
          style={{
            fontSize: '0.7rem',
            fontWeight: 500,
            color: theme.text.muted
          }}
        >
          {item.label}
        </div>
      )
    }

    if (item.kind === 'thread') {
      const threadNode = renderThreadItem(item.thread)
      if (mode === 'archived') {
        return <div key={item.thread.id}>{threadNode}</div>
      }
      return (
        <DroppableThread key={item.thread.id} threadId={item.thread.id}>
          <DraggableThread thread={item.thread}>{threadNode}</DraggableThread>
        </DroppableThread>
      )
    }

    if (item.kind === 'folder') {
      const isCollapsed = collapsedFolderIds.has(item.folder.id)
      const folderThreads = item.threads
      const folderNode = (
        <ThreadFolderItem
          folder={item.folder}
          isCollapsed={isCollapsed}
          threadCount={folderThreads.length}
          mode={mode}
          onToggle={() => toggleFolderCollapsed(item.folder.id)}
          onRename={(title) => void renameFolder(item.folder.id, title)}
          onSetColor={(colorTag) => void setFolderColor(item.folder.id, colorTag)}
          onDelete={() => void deleteFolder(item.folder.id)}
          onArchiveAll={() => archiveFolder(item.folder, folderThreads)}
          onRestoreAll={() => restoreFolder(item.folder, folderThreads)}
        >
          {item.children.map((child) => {
            if (child.kind === 'folder-date-header') {
              return (
                <div
                  key={`__fdate__${child.label}`}
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
            if (mode === 'archived') {
              return <div key={child.thread.id}>{renderThreadItem(child.thread)}</div>
            }
            return (
              <DraggableThread key={child.thread.id} thread={child.thread}>
                {renderThreadItem(child.thread)}
              </DraggableThread>
            )
          })}
        </ThreadFolderItem>
      )
      if (mode === 'archived') {
        return <div key={`folder-${item.folder.id}`}>{folderNode}</div>
      }
      return (
        <DroppableFolder key={`folder-${item.folder.id}`} folderId={item.folder.id}>
          {folderNode}
        </DroppableFolder>
      )
    }

    return null
  })

  if (mode === 'archived') {
    return <>{renderedItems}</>
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
      {renderedItems}
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
  setActiveArchivedThread,
  setActiveThread,
  setThreadIcon,
  starThread,
  threadListMode,
  visibleThreads,
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
  latestRunsByThread: Record<string, { status: string }>
  memoryEnabled: boolean
  regenerateThreadTitle: (threadId: string) => Promise<void>
  renameThread: (threadId: string, title: string) => Promise<void>
  restoreThread: (threadId: string) => Promise<void>
  saveThread: (threadId: string, options: { archiveAfterSave: boolean }) => Promise<void>
  savingThreadIds: Set<string>
  setActiveArchivedThread: (threadId: string) => void
  setActiveThread: (threadId: string) => void
  setThreadIcon: (threadId: string, icon: string | null) => Promise<void>
  starThread: (threadId: string, starred: boolean) => Promise<void>
  threadListMode: 'active' | 'archived'
  visibleThreads: Thread[]
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
  const showPreview = useAppStore((s) => s.config?.general?.sidebarPreview) !== false

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

  function renderThreadItem(thread: Thread): React.JSX.Element {
    return (
      <ThreadListItem
        key={thread.id}
        thread={thread}
        isActive={thread.id === activeId}
        hasActiveRun={runStatusesByThread[thread.id] === 'running'}
        isSaving={savingThreadIds.has(thread.id)}
        isSelectMode={selectMode}
        isSelected={selectedIds.has(thread.id)}
        isStarred={!!thread.starredAt}
        showPreview={showPreview}
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
      <div key={threadListMode} className="flex-1 overflow-y-auto px-2 py-1 yachiyo-thread-enter">
        {visibleThreads.length === 0 ? (
          <div className="px-4 py-6 text-sm leading-6" style={{ color: theme.text.muted }}>
            {threadListMode === 'archived'
              ? 'No archived threads yet.'
              : 'No chats yet. Start one from the compose box or the new chat button.'}
          </div>
        ) : null}
        <FolderAwareThreadList
          threads={visibleThreads}
          folders={folders}
          collapsedFolderIds={collapsedFolderIds}
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
  const externalThreads = useAppStore((s) => s.externalThreads)
  const showExternalThreads = useAppStore((s) => s.showExternalThreads)
  const runStatusesByThread = useAppStore((s) => s.runStatusesByThread)
  const config = useAppStore((s) => s.config)
  const baseThreads = threadListMode === 'archived' ? archivedThreads : threads
  const allThreads =
    showExternalThreads && threadListMode === 'active'
      ? [...baseThreads, ...externalThreads].sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt)
        )
      : baseThreads
  // Hide empty "New Chat" threads — they only appear in the sidebar once the user sends a message
  // or when they already have an active run (e.g. kicked off from elsewhere).
  // Also hide schedule-spawned threads while they're still running: they auto-archive on
  // completion (see scheduleService), so surfacing them mid-run is just sidebar noise.
  const visibleThreads = allThreads.filter((t) => {
    const isRunning = runStatusesByThread[t.id] === 'running'
    if (isRunning && t.createdFromScheduleId) return false
    return t.title !== 'New Chat' || t.preview || t.headMessageId || isRunning
  })
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
      latestRunsByThread={latestRunsByThread as Record<string, { status: string }>}
      memoryEnabled={memoryEnabled}
      regenerateThreadTitle={regenerateThreadTitle}
      renameThread={renameThread}
      restoreThread={restoreThread}
      saveThread={saveThread}
      savingThreadIds={savingThreadIds}
      setActiveArchivedThread={setActiveArchivedThread}
      setActiveThread={setActiveThread}
      setThreadIcon={setThreadIcon}
      starThread={starThread}
      threadListMode={threadListMode}
      visibleThreads={visibleThreads}
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
