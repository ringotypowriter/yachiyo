import type React from 'react'
import { useState } from 'react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { Thread } from '@renderer/app/types'
import { ThreadContextMenuPopup } from '@renderer/features/threads/components/ThreadContextMenuPopup'
import {
  resolveThreadContextOperations,
  type ThreadContextOperationKey
} from '@renderer/features/threads/lib/threadContextOperations'
import { theme } from '@renderer/theme/theme'
import { isMemoryConfigured } from '../../../../../shared/yachiyo/protocol.ts'

function ThreadListItem({
  isActive,
  isMemoryEnabled,
  onSelectOperation,
  onSelectThread,
  thread,
  threadListMode
}: {
  isActive: boolean
  isMemoryEnabled: boolean
  onSelectOperation: (thread: Thread, operationKey: ThreadContextOperationKey) => void
  onSelectThread: (threadId: string) => void
  thread: Thread
  threadListMode: 'active' | 'archived'
}): React.JSX.Element {
  const preview = thread.preview?.trim() || 'No messages yet'
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const operations = resolveThreadContextOperations({
    isArchived: threadListMode === 'archived',
    isMemoryEnabled: isMemoryEnabled && !thread.privacyMode
  })

  return (
    <>
      <button
        onClick={() => onSelectThread(thread.id)}
        className="w-full text-left px-3 py-2.5 rounded-lg transition-colors no-drag"
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
        <span
          className="block text-sm truncate font-medium"
          style={{ color: isActive ? theme.text.primary : theme.text.secondary }}
        >
          {thread.title}
        </span>
        <span
          className="mt-0.5 block text-xs truncate"
          style={{ color: isActive ? theme.text.secondary : theme.text.muted }}
        >
          {preview}
        </span>
      </button>
      {menuPosition ? (
        <ThreadContextMenuPopup
          position={menuPosition}
          operations={operations}
          onClose={() => setMenuPosition(null)}
          onSelect={(operationKey) => onSelectOperation(thread, operationKey)}
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
  const activeRunThreadId = useAppStore((s) => s.activeRunThreadId)
  const cancelActiveRun = useAppStore((s) => s.cancelActiveRun)
  const deleteThread = useAppStore((s) => s.deleteThread)
  const renameThread = useAppStore((s) => s.renameThread)
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
      if (operationKey === 'rename') {
        const nextTitle = window.prompt('Rename thread', thread.title)?.trim()
        if (!nextTitle || nextTitle === thread.title) {
          return
        }
        await renameThread(thread.id, nextTitle)
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

      if (activeRunThreadId === thread.id) {
        if (!window.confirm(`"${thread.title}" has an active run. Cancel the run and delete?`)) {
          return
        }
        await cancelActiveRun()
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
          isMemoryEnabled={memoryEnabled}
          threadListMode={threadListMode}
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
        />
      ))}
    </div>
  )
}
