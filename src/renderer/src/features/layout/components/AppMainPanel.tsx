import { useState } from 'react'
import type { Message, Thread } from '@renderer/app/types'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { Composer } from '@renderer/features/chat/components/Composer'
import { MessageTimeline } from '@renderer/features/chat/components/MessageTimeline'
import { ArchivedThreadsPage } from '@renderer/features/layout/components/ArchivedThreadsPage'
import { AppMainPanelHeader } from '@renderer/features/layout/components/AppMainPanelHeader'
import { RunStatusStrip } from '@renderer/features/runs/components/RunStatusStrip'
import type { ThreadContextOperationKey } from '@renderer/features/threads/lib/threadContextOperations'
import { theme } from '@renderer/theme/theme'
import { isMemoryConfigured } from '../../../../../shared/yachiyo/protocol.ts'

const EMPTY: Message[] = []

export interface AppMainPanelProps {
  headerPaddingLeft: number
  isSidebarToggleDisabled: boolean
  showSidebarToggle: boolean
  onToggleSidebar: () => void
  toggleSidebarTitle: string
}

export function AppMainPanel({
  headerPaddingLeft,
  isSidebarToggleDisabled,
  showSidebarToggle,
  onToggleSidebar,
  toggleSidebarTitle
}: AppMainPanelProps): React.JSX.Element {
  const archiveThread = useAppStore((s) => s.archiveThread)
  const archivedThreads = useAppStore((s) => s.archivedThreads)
  const activeArchivedThreadId = useAppStore((s) => s.activeArchivedThreadId)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const deleteThread = useAppStore((s) => s.deleteThread)
  const compactThreadToAnotherThread = useAppStore((s) => s.compactThreadToAnotherThread)
  const messages = useAppStore((s) =>
    activeThreadId ? (s.messages[activeThreadId] ?? EMPTY) : EMPTY
  )
  const renameThread = useAppStore((s) => s.renameThread)
  const restoreThread = useAppStore((s) => s.restoreThread)
  const threadListMode = useAppStore((s) => s.threadListMode)
  const threads = useAppStore((s) => s.threads)
  const isBootstrapping = useAppStore((s) => s.isBootstrapping)
  const messageCount = messages.length
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null
  const config = useAppStore((s) => s.config)
  const activeArchivedThread =
    archivedThreads.find((thread) => thread.id === activeArchivedThreadId) ?? null
  const saveThread = useAppStore((s) => s.saveThread)
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null)
  const memoryEnabled = isMemoryConfigured(config)

  async function handleRenameThread(thread: Thread): Promise<void> {
    if (renamingThreadId === thread.id) {
      return
    }

    setRenamingThreadId(thread.id)
    try {
      const nextTitle = window.prompt('Rename thread', thread.title)?.trim()
      if (!nextTitle || nextTitle === thread.title) {
        return
      }

      await renameThread(thread.id, nextTitle)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to rename the thread.')
    } finally {
      setRenamingThreadId(null)
    }
  }

  async function handleArchiveThread(thread: Thread): Promise<void> {
    if (!window.confirm(`Archive "${thread.title}"?`)) {
      return
    }

    try {
      await archiveThread(thread.id)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to archive the thread.')
    }
  }

  async function handleDeleteThread(thread: Thread): Promise<void> {
    if (!window.confirm(`Delete "${thread.title}" permanently?`)) {
      return
    }

    try {
      await deleteThread(thread.id)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to delete the thread.')
    }
  }

  async function handleRestoreThread(thread: Thread): Promise<void> {
    try {
      await restoreThread(thread.id)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to restore the thread.')
    }
  }

  async function handleOpenThreadWorkspace(): Promise<void> {
    if (!activeThread) return

    try {
      await window.api.yachiyo.openThreadWorkspace({ threadId: activeThread.id })
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to open the workspace.')
    }
  }

  function handleSelectThreadOperation(operationKey: ThreadContextOperationKey): void {
    if (!activeThread) {
      return
    }

    if (operationKey === 'rename') {
      void handleRenameThread(activeThread)
      return
    }

    if (operationKey === 'archive') {
      void handleArchiveThread(activeThread)
      return
    }

    if (operationKey === 'compact-to-another-thread') {
      void (async () => {
        try {
          await compactThreadToAnotherThread()
        } catch (error) {
          window.alert(
            error instanceof Error ? error.message : 'Failed to compact into another thread.'
          )
        }
      })()
      return
    }

    if (operationKey === 'save-thread') {
      void (async () => {
        try {
          await saveThread(activeThread.id, {
            archiveAfterSave: window.confirm(
              `Archive "${activeThread.title}" after saving it to long-term memory?`
            )
          })
        } catch (error) {
          window.alert(error instanceof Error ? error.message : 'Failed to save the thread.')
        }
      })()
      return
    }

    if (operationKey === 'delete') {
      void handleDeleteThread(activeThread)
    }
  }

  if (threadListMode === 'archived') {
    return (
      <div
        className="flex flex-col flex-1 h-full min-w-0"
        style={{ background: theme.background.canvas }}
      >
        <div
          className="flex items-center shrink-0 drag-region"
          style={{
            height: '52px',
            paddingLeft: `${headerPaddingLeft}px`,
            paddingRight: '20px',
            borderBottom: `1px solid ${theme.border.default}`
          }}
        >
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
              Archived
            </div>
            <div className="text-xs font-medium" style={{ color: theme.text.muted }}>
              {archivedThreads.length} thread{archivedThreads.length !== 1 ? 's' : ''}
            </div>
          </div>
        </div>
        <ArchivedThreadsPage
          activeThread={activeArchivedThread}
          onDeleteThread={handleDeleteThread}
          onRestoreThread={handleRestoreThread}
        />
      </div>
    )
  }

  return (
    <div
      className="flex flex-col flex-1 h-full min-w-0"
      style={{ background: theme.background.canvas }}
    >
      <AppMainPanelHeader
        activeThread={activeThread}
        headerPaddingLeft={headerPaddingLeft}
        isBootstrapping={isBootstrapping}
        isMemoryEnabled={memoryEnabled}
        isSidebarToggleDisabled={isSidebarToggleDisabled}
        messageCount={messageCount}
        onOpenThreadWorkspace={handleOpenThreadWorkspace}
        onSelectThreadOperation={handleSelectThreadOperation}
        onToggleSidebar={onToggleSidebar}
        showSidebarToggle={showSidebarToggle}
        toggleSidebarTitle={toggleSidebarTitle}
      />

      <MessageTimeline key={activeThreadId ?? 'empty'} threadId={activeThreadId} />
      <RunStatusStrip />
      <Composer />
    </div>
  )
}
