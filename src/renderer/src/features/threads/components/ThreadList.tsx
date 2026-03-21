import type React from 'react'
import { useState } from 'react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { Thread } from '@renderer/app/types'
import { ThreadContextMenuPopup } from '@renderer/features/threads/components/ThreadContextMenuPopup'
import {
  resolveThreadContextOperations,
  type ThreadContextOperationKey
} from '@renderer/features/threads/lib/threadContextOperations'

function ThreadListItem({
  isActive,
  onSelectOperation,
  onSelectThread,
  thread,
  threadListMode
}: {
  isActive: boolean
  onSelectOperation: (thread: Thread, operationKey: ThreadContextOperationKey) => void
  onSelectThread: (threadId: string) => void
  thread: Thread
  threadListMode: 'active' | 'archived'
}): React.JSX.Element {
  const preview = thread.preview?.trim() || 'No messages yet'
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null)
  const operations = resolveThreadContextOperations({
    isArchived: threadListMode === 'archived'
  })

  return (
    <>
      <button
        onClick={() => onSelectThread(thread.id)}
        className="w-full text-left px-3 py-2.5 rounded-lg transition-colors no-drag"
        style={{
          background: isActive ? 'rgba(0,0,0,0.07)' : 'transparent'
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
          if (!isActive) (e.currentTarget as HTMLElement).style.background = 'rgba(0,0,0,0.04)'
        }}
        onMouseLeave={(e) => {
          if (!isActive) (e.currentTarget as HTMLElement).style.background = 'transparent'
        }}
      >
        <span
          className="block text-sm truncate font-medium"
          style={{ color: isActive ? '#2D2D2B' : '#3a3a3c' }}
        >
          {thread.title}
        </span>
        <span
          className="mt-0.5 block text-xs truncate"
          style={{ color: isActive ? '#5b5a57' : '#8e8e93' }}
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
  const deleteThread = useAppStore((s) => s.deleteThread)
  const renameThread = useAppStore((s) => s.renameThread)
  const restoreThread = useAppStore((s) => s.restoreThread)
  const setActiveArchivedThread = useAppStore((s) => s.setActiveArchivedThread)
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const threadListMode = useAppStore((s) => s.threadListMode)
  const threads = useAppStore((s) => s.threads)
  const visibleThreads = threadListMode === 'archived' ? archivedThreads : threads
  const activeId = threadListMode === 'archived' ? activeArchivedThreadId : activeThreadId

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

      if (operationKey === 'restore') {
        await restoreThread(thread.id)
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
        <div className="px-4 py-6 text-sm leading-6" style={{ color: '#8e8e93' }}>
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
