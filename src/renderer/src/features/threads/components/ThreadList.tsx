import type React from 'react'
import { useRef, useState } from 'react'
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

function ThreadListItem({
  isActive,
  hasActiveRun,
  isMemoryEnabled,
  onRename,
  onSelectOperation,
  onSelectThread,
  onSetIcon,
  thread,
  threadListMode
}: {
  isActive: boolean
  hasActiveRun: boolean
  isMemoryEnabled: boolean
  onRename: (thread: Thread, nextTitle: string) => void
  onSelectOperation: (thread: Thread, operationKey: ThreadContextOperationKey) => void
  onSelectThread: (threadId: string) => void
  onSetIcon: (thread: Thread, icon: string | null) => void
  thread: Thread
  threadListMode: 'active' | 'archived'
}): React.JSX.Element {
  const preview = thread.preview?.trim() || 'No messages yet'
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const [renamingTitle, setRenamingTitle] = useState(false)
  const iconInputRef = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const operations = resolveThreadContextOperations({
    isArchived: threadListMode === 'archived',
    isMemoryEnabled: isMemoryEnabled && !thread.privacyMode
  })

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
    // Reset the hidden input so it's ready for the next pick
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

  function handleSelectOperation(operationKey: ThreadContextOperationKey): void {
    if (operationKey === 'rename') {
      setRenamingTitle(true)
      return
    }
    onSelectOperation(thread, operationKey)
  }

  return (
    <>
      <button
        onClick={() => onSelectThread(thread.id)}
        className="relative w-full text-left px-3 py-2.5 rounded-lg transition-colors no-drag"
        style={{
          background: isActive ? theme.background.code : 'transparent'
        }}
        onContextMenu={(event) => {
          event.preventDefault()
          onSelectThread(thread.id)
          setMenuPosition({
            left: event.clientX,
            top: event.clientY
          })
        }}
        onMouseEnter={(e) => {
          if (!isActive) (e.currentTarget as HTMLElement).style.background = theme.background.hover
        }}
        onMouseLeave={(e) => {
          if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'
        }}
      >
        <div className="flex items-stretch gap-2 pr-4">
          {thread.icon ? (
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
              style={{ color: isActive ? theme.text.primary : theme.text.secondary }}
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
                    color: isActive ? theme.text.primary : theme.text.secondary,
                    fontSize: 'inherit',
                    fontWeight: 'inherit'
                  }}
                />
              ) : (
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              )}
            </span>
            <span
              className="mt-0.5 block truncate"
              style={{
                fontSize: '0.68rem',
                color: isActive ? theme.text.secondary : theme.text.muted
              }}
            >
              {preview}
            </span>
          </div>
        </div>
        {hasActiveRun ? (
          <span
            aria-label="Run active"
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full"
            style={{
              width: '7px',
              height: '7px',
              background: theme.text.accentStrong,
              opacity: isActive ? 1 : 0.8
            }}
          />
        ) : null}
      </button>
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

export function ThreadList(): React.JSX.Element {
  const activeArchivedThreadId = useAppStore((s) => s.activeArchivedThreadId)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const archiveThread = useAppStore((s) => s.archiveThread)
  const archivedThreads = useAppStore((s) => s.archivedThreads)
  const compactThreadToAnotherThread = useAppStore((s) => s.compactThreadToAnotherThread)
  const cancelRunForThread = useAppStore((s) => s.cancelRunForThread)
  const deleteThread = useAppStore((s) => s.deleteThread)
  const latestRunsByThread = useAppStore((s) => s.latestRunsByThread)
  const renameThread = useAppStore((s) => s.renameThread)
  const setThreadIcon = useAppStore((s) => s.setThreadIcon)
  const restoreThread = useAppStore((s) => s.restoreThread)
  const saveThread = useAppStore((s) => s.saveThread)
  const setActiveArchivedThread = useAppStore((s) => s.setActiveArchivedThread)
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const threadListMode = useAppStore((s) => s.threadListMode)
  const threads = useAppStore((s) => s.threads)
  const config = useAppStore((s) => s.config)
  const visibleThreads = threadListMode === 'archived' ? archivedThreads : threads
  const activeId = threadListMode === 'archived' ? activeArchivedThreadId : activeThreadId
  const memoryEnabled = isMemoryConfigured(config)

  async function handleSelectOperation(
    thread: Thread,
    operationKey: ThreadContextOperationKey
  ): Promise<void> {
    try {
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

  return (
    <div className="flex-1 overflow-y-auto px-2 py-1">
      {visibleThreads.length === 0 ? (
        <div className="px-4 py-6 text-sm leading-6" style={{ color: theme.text.muted }}>
          {threadListMode === 'archived'
            ? 'No archived threads yet.'
            : 'No chats yet. Start one from the compose box or the new chat button.'}
        </div>
      ) : null}
      {visibleThreads.map((thread) => (
        <ThreadListItem
          key={thread.id}
          thread={thread}
          isActive={thread.id === activeId}
          hasActiveRun={latestRunsByThread[thread.id]?.status === 'running'}
          isMemoryEnabled={memoryEnabled}
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
        />
      ))}
    </div>
  )
}
