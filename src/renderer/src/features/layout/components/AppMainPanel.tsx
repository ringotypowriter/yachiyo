import { useState } from 'react'
import type { Message } from '@renderer/app/types'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { Composer } from '@renderer/features/chat/components/Composer'
import { AppMainPanelHeader } from '@renderer/features/layout/components/AppMainPanelHeader'
import { MessageTimeline } from '@renderer/features/chat/components/MessageTimeline'
import { RunStatusStrip } from '@renderer/features/runs/components/RunStatusStrip'

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
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const messages = useAppStore((s) =>
    activeThreadId ? (s.messages[activeThreadId] ?? EMPTY) : EMPTY
  )
  const renameThread = useAppStore((s) => s.renameThread)
  const runStatus = useAppStore((s) => s.runStatus)
  const threads = useAppStore((s) => s.threads)
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const isBootstrapping = useAppStore((s) => s.isBootstrapping)
  const messageCount = messages.length
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null
  const [editingTitleFor, setEditingTitleFor] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const isEditingTitle = editingTitleFor === activeThread?.id

  function handleStartRename(): void {
    if (!activeThread) {
      return
    }

    setDraftTitle(activeThread.title)
    setEditingTitleFor(activeThread.id)
  }

  function handleCancelRename(): void {
    setDraftTitle(activeThread?.title ?? '')
    setEditingTitleFor(null)
  }

  async function commitTitleRename(): Promise<void> {
    if (!activeThread) return

    const title = draftTitle.trim()
    if (!title || title === activeThread.title) {
      setDraftTitle(activeThread.title)
      setEditingTitleFor(null)
      return
    }

    try {
      await renameThread(activeThread.id, title)
      setEditingTitleFor(null)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to rename the thread.')
    }
  }

  async function handleArchiveThread(): Promise<void> {
    if (!activeThread) return
    if (!window.confirm(`Archive "${activeThread.title}"?`)) return

    try {
      await archiveThread(activeThread.id)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to archive the thread.')
    }
  }

  return (
    <div className="flex flex-col flex-1 h-full min-w-0" style={{ background: '#F9F9F7' }}>
      <AppMainPanelHeader
        activeThread={activeThread}
        connectionStatus={connectionStatus}
        draftTitle={draftTitle}
        headerPaddingLeft={headerPaddingLeft}
        isArchiveDisabled={runStatus === 'running'}
        isBootstrapping={isBootstrapping}
        isEditingTitle={isEditingTitle}
        isSidebarToggleDisabled={isSidebarToggleDisabled}
        messageCount={messageCount}
        onArchiveThread={handleArchiveThread}
        onCancelRename={handleCancelRename}
        onCommitRename={commitTitleRename}
        onDraftTitleChange={(nextTitle) => setDraftTitle(nextTitle)}
        onStartRename={handleStartRename}
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
