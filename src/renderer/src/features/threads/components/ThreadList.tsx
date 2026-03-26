import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Archive, Check, RotateCcw, Sparkles, Star, Trash2, X } from 'lucide-react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { Thread } from '@renderer/app/types'
import { ThreadContextMenuPopup } from '@renderer/features/threads/components/ThreadContextMenuPopup'
import {
  resolveThreadContextOperations,
  type ThreadContextOperationKey
} from '@renderer/features/threads/lib/threadContextOperations'
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

function groupThreadsByDate(threads: Thread[]): Array<{ label: string; threads: Thread[] }> {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  const groups = new Map<string, Thread[]>()

  for (const thread of threads) {
    const date = new Date(thread.updatedAt)
    const threadDay = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    const diffMs = today.getTime() - threadDay.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    let label: string
    if (diffDays === 0) {
      label = 'Today'
    } else if (diffDays === 1) {
      label = 'Yesterday'
    } else {
      label = threadDay.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      })
    }

    if (!groups.has(label)) {
      groups.set(label, [])
    }
    groups.get(label)!.push(thread)
  }

  return [...groups.entries()].map(([label, threads]) => ({ label, threads }))
}

function ThreadListItem({
  isActive,
  hasActiveRun,
  isMemoryEnabled,
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
  thread,
  threadListMode
}: {
  isActive: boolean
  hasActiveRun: boolean
  isMemoryEnabled: boolean
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
  thread: Thread
  threadListMode: 'active' | 'archived'
}): React.JSX.Element {
  const preview = thread.preview?.trim() || 'No messages yet'
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const [renamingTitle, setRenamingTitle] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const iconInputRef = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const operations = resolveThreadContextOperations({
    isArchived: threadListMode === 'archived',
    isMemoryEnabled: isMemoryEnabled && !thread.privacyMode,
    isSaving,
    isStarred
  })

  const displayedTitle = useTitleAnimation(thread.title, renamingTitle)

  const isHighlighted = isSelectMode ? isSelected : isActive

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
    if (e.key === 'Enter') {
      e.currentTarget.blur()
    } else if (e.key === 'Escape') {
      setRenamingTitle(false)
    }
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
          className="relative w-full text-left px-3 py-2.5 rounded-lg transition-colors no-drag"
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
          <div className="flex items-stretch gap-2 pr-4">
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
                style={{ fontSize: '1.45em' }}
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
            ) : null}
            <div className="min-w-0 flex-1">
              <span
                className="flex items-center gap-1.5 text-sm font-medium"
                style={{ color: isHighlighted ? theme.text.primary : theme.text.secondary }}
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
              <span
                className="mt-0.5 block truncate"
                style={{
                  fontSize: '0.68rem',
                  color: isHighlighted ? theme.text.secondary : theme.text.muted
                }}
              >
                {preview}
              </span>
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
          ) : null}
        </button>
        {!isSelectMode ? (
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
  visibleThreads
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
}): React.JSX.Element {
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

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
        if (window.confirm(`Archive "${thread.title}"?`)) {
          await archiveThread(thread.id)
        }
        return
      }

      if (operationKey === 'compact-to-another-thread') {
        setActiveThread(thread.id)
        await compactThreadToAnotherThread()
        return
      }

      if (operationKey === 'save-thread') {
        if (savingThreadIds.has(thread.id)) return
        await saveThread(thread.id, {
          archiveAfterSave: window.confirm(
            `Archive "${thread.title}" after saving it to long-term memory?`
          )
        })
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
    if (!window.confirm(`Archive ${ids.length} thread${ids.length !== 1 ? 's' : ''}?`)) return
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

  function renderThreadItem(thread: Thread): React.JSX.Element {
    return (
      <ThreadListItem
        key={thread.id}
        thread={thread}
        isActive={thread.id === activeId}
        hasActiveRun={latestRunsByThread[thread.id]?.status === 'running'}
        isMemoryEnabled={memoryEnabled}
        isSaving={savingThreadIds.has(thread.id)}
        isSelectMode={selectMode}
        isSelected={selectedIds.has(thread.id)}
        isStarred={!!thread.starredAt}
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
      {selectMode ? (
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
      ) : null}
      <div className="flex-1 overflow-y-auto px-2 py-1">
        {visibleThreads.length === 0 ? (
          <div className="px-4 py-6 text-sm leading-6" style={{ color: theme.text.muted }}>
            {threadListMode === 'archived'
              ? 'No archived threads yet.'
              : 'No chats yet. Start one from the compose box or the new chat button.'}
          </div>
        ) : null}
        {threadListMode === 'active' ? (
          <>
            {(() => {
              const starredThreads = visibleThreads.filter((t) => t.starredAt)
              if (starredThreads.length === 0) return null
              return (
                <>
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
                  {starredThreads.map(renderThreadItem)}
                </>
              )
            })()}
            {(() => {
              const unstarredThreads = visibleThreads.filter((t) => !t.starredAt)
              const groups = groupThreadsByDate(unstarredThreads)
              return groups.map(({ label, threads: groupThreads }) => (
                <div key={label}>
                  <div
                    className="px-3 pt-2 pb-1"
                    style={{
                      fontSize: '0.7rem',
                      fontWeight: 500,
                      color: theme.text.muted
                    }}
                  >
                    {label}
                  </div>
                  {groupThreads.map(renderThreadItem)}
                </div>
              ))
            })()}
          </>
        ) : (
          visibleThreads.map(renderThreadItem)
        )}
      </div>
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
  const restoreThread = useAppStore((s) => s.restoreThread)
  const saveThread = useAppStore((s) => s.saveThread)
  const savingThreadIds = useAppStore((s) => s.savingThreadIds)
  const setActiveArchivedThread = useAppStore((s) => s.setActiveArchivedThread)
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const threadListMode = useAppStore((s) => s.threadListMode)
  const threads = useAppStore((s) => s.threads)
  const config = useAppStore((s) => s.config)
  const visibleThreads = threadListMode === 'archived' ? archivedThreads : threads
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
    />
  )
}
