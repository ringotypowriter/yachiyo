import { PanelLeft, Search, SquarePen, Settings } from 'lucide-react'
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
        <button className="p-1.5 rounded-md opacity-40 hover:opacity-70 transition-opacity" style={{ color: '#1c1c1e' }}>
          <Settings size={16} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  )
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

const EMPTY: Message[] = []

function MainPanel() {
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const messages = useAppStore((s) => s.messages[activeThreadId] ?? EMPTY)
  const messageCount = messages.length

  return (
    <div
      className="flex flex-col flex-1 h-full min-w-0"
      style={{ background: '#f5f4f0' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-center shrink-0 drag-region relative"
        style={{ height: '52px', borderBottom: '1px solid rgba(0,0,0,0.06)' }}
      >
        <span className="text-xs font-medium" style={{ color: '#8e8e93' }}>
          {messageCount > 0 ? `${messageCount} message${messageCount !== 1 ? 's' : ''}` : '0 messages'}
        </span>
      </div>

      {/* Message timeline */}
      <MessageTimeline key={activeThreadId} threadId={activeThreadId} />

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
