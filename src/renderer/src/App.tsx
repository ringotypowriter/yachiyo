import { useEffect, useState } from 'react'
import {
  Archive,
  Check,
  PanelLeft,
  PencilLine,
  Search,
  Settings,
  SquarePen,
  X,
} from 'lucide-react'
import type { Message } from '@renderer/app/types'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { ThreadList } from '@renderer/features/threads/components/ThreadList'
import { MessageTimeline } from '@renderer/features/chat/components/MessageTimeline'
import { Composer } from '@renderer/features/chat/components/Composer'
import { RunStatusStrip } from '@renderer/features/runs/components/RunStatusStrip'

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar() {
  const createNewThread = useAppStore((s) => s.createNewThread)

  return (
    <div
      className="flex flex-col h-full shrink-0"
      style={{ width: '260px', background: '#eeede9' }}
    >
      {/* Top bar — traffic lights zone + icons */}
      <div
        className="flex items-center drag-region shrink-0"
        style={{ height: '52px', paddingLeft: '80px', paddingRight: '12px' }}
      >
        <div className="flex items-center gap-1 no-drag ml-auto">
          <button className="p-1.5 rounded-md opacity-50 hover:opacity-80 transition-opacity" style={{ color: '#1c1c1e' }}>
            <PanelLeft size={16} strokeWidth={1.5} />
          </button>
          <button className="p-1.5 rounded-md opacity-50 hover:opacity-80 transition-opacity" style={{ color: '#1c1c1e' }}>
            <Search size={15} strokeWidth={1.5} />
          </button>
          <button
            onClick={createNewThread}
            className="p-1.5 rounded-md opacity-50 hover:opacity-80 transition-opacity"
            style={{ color: '#1c1c1e' }}
            title="New chat"
          >
            <SquarePen size={15} strokeWidth={1.5} />
          </button>
        </div>
      </div>

      {/* Thread list */}
      <ThreadList />

      {/* Bottom settings */}
      <div className="shrink-0 px-3 py-3 no-drag">
        <button
          onClick={() => window.api.openSettings()}
          className="p-1.5 rounded-md opacity-40 hover:opacity-70 transition-opacity"
          style={{ color: '#1c1c1e' }}
        >
          <Settings size={16} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

const EMPTY: Message[] = []

function MainPanel() {
  const archiveThread = useAppStore((s) => s.archiveThread)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const messages = useAppStore((s) => (activeThreadId ? s.messages[activeThreadId] ?? EMPTY : EMPTY))
  const renameThread = useAppStore((s) => s.renameThread)
  const runStatus = useAppStore((s) => s.runStatus)
  const threads = useAppStore((s) => s.threads)
  const connectionStatus = useAppStore((s) => s.connectionStatus)
  const isBootstrapping = useAppStore((s) => s.isBootstrapping)
  const messageCount = messages.length
  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null
  const [draftTitle, setDraftTitle] = useState('')
  const [isEditingTitle, setIsEditingTitle] = useState(false)

  useEffect(() => {
    setDraftTitle(activeThread?.title ?? '')
    setIsEditingTitle(false)
  }, [activeThread?.id, activeThread?.title])

  async function commitTitleRename() {
    if (!activeThread) return

    const title = draftTitle.trim()
    if (!title || title === activeThread.title) {
      setDraftTitle(activeThread.title)
      setIsEditingTitle(false)
      return
    }

    try {
      await renameThread(activeThread.id, title)
      setIsEditingTitle(false)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to rename the thread.')
    }
  }

  async function handleArchiveThread() {
    if (!activeThread) return
    if (!window.confirm(`Archive "${activeThread.title}"?`)) return

    try {
      await archiveThread(activeThread.id)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Failed to archive the thread.')
    }
  }

  return (
    <div
      className="flex flex-col flex-1 h-full min-w-0"
      style={{ background: '#f5f4f0' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between shrink-0 drag-region px-5"
        style={{ height: '52px', borderBottom: '1px solid rgba(0,0,0,0.06)' }}
      >
        <div className="flex flex-col min-w-0">
          {activeThread && isEditingTitle ? (
            <div className="no-drag flex items-center gap-1">
              <input
                autoFocus
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                onBlur={() => void commitTitleRename()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void commitTitleRename()
                  }

                  if (event.key === 'Escape') {
                    setDraftTitle(activeThread.title)
                    setIsEditingTitle(false)
                  }
                }}
                className="h-8 rounded-md border px-2 text-sm font-semibold outline-none"
                style={{
                  background: 'rgba(255,255,255,0.88)',
                  borderColor: 'rgba(0,0,0,0.08)',
                  color: '#1c1c1e',
                  letterSpacing: '-0.2px',
                }}
              />
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void commitTitleRename()}
                className="rounded-md p-1 no-drag transition-opacity opacity-70 hover:opacity-100"
                style={{ color: '#2e6664' }}
                title="Save title"
              >
                <Check size={14} strokeWidth={1.8} />
              </button>
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setDraftTitle(activeThread.title)
                  setIsEditingTitle(false)
                }}
                className="rounded-md p-1 no-drag transition-opacity opacity-70 hover:opacity-100"
                style={{ color: '#8e8e93' }}
                title="Cancel rename"
              >
                <X size={14} strokeWidth={1.8} />
              </button>
            </div>
          ) : (
            <span
              className="text-sm font-semibold truncate"
              style={{ color: '#1c1c1e', letterSpacing: '-0.2px' }}
            >
              {activeThread?.title ?? 'Start a conversation'}
            </span>
          )}
          <span className="text-xs font-medium" style={{ color: '#8e8e93' }}>
            {isBootstrapping
              ? 'Loading local workspace...'
              : messageCount > 0
                ? `${messageCount} message${messageCount !== 1 ? 's' : ''}`
                : 'No messages yet'}
          </span>
        </div>

        <div className="flex items-center gap-2 no-drag">
          {activeThread ? (
            <>
              <button
                onClick={() => setIsEditingTitle(true)}
                disabled={isEditingTitle}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-opacity disabled:opacity-40"
                style={{
                  background: 'rgba(255,255,255,0.72)',
                  border: '1px solid rgba(0,0,0,0.08)',
                  color: '#5b5a57',
                }}
                title="Rename thread"
              >
                <PencilLine size={12} strokeWidth={1.7} />
                Rename
              </button>
              <button
                onClick={() => void handleArchiveThread()}
                disabled={runStatus === 'running'}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-opacity disabled:opacity-40"
                style={{
                  background: 'rgba(255,255,255,0.72)',
                  border: '1px solid rgba(0,0,0,0.08)',
                  color: '#7b3f39',
                }}
                title="Archive thread"
              >
                <Archive size={12} strokeWidth={1.7} />
                Archive
              </button>
            </>
          ) : null}
          <span
            className="flex items-center justify-center rounded-full"
            title={connectionStatus === 'connected' ? 'Server ready' : 'Server offline'}
            aria-label={connectionStatus === 'connected' ? 'Server ready' : 'Server offline'}
            style={{
              width: '26px',
              height: '26px',
              background: 'rgba(255,255,255,0.52)',
              border: '1px solid rgba(0,0,0,0.05)',
            }}
          >
            <span
              className="rounded-full"
              style={{
                width: '8px',
                height: '8px',
                background:
                  connectionStatus === 'connected'
                    ? 'rgba(78, 131, 102, 0.78)'
                    : 'rgba(182, 92, 84, 0.76)',
              }}
            />
          </span>
        </div>
      </div>

      {/* Message timeline */}
      <MessageTimeline key={activeThreadId ?? 'empty'} threadId={activeThreadId} />

      {/* Run status */}
      <RunStatusStrip />

      {/* Composer */}
      <Composer />
    </div>
  )
}

// ─── App Shell ────────────────────────────────────────────────────────────────

function App(): React.JSX.Element {
  return (
    <div className="flex h-full overflow-hidden">
      {/* Divider */}
      <div style={{ width: '1px', background: 'rgba(0,0,0,0.08)', position: 'absolute', left: '260px', top: 0, bottom: 0, zIndex: 1 }} />
      <Sidebar />
      <MainPanel />
    </div>
  )
}

export default App
