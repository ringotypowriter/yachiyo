import { useAppStore } from '@renderer/app/store/useAppStore'
import type { Thread } from '@renderer/app/types'

function ThreadListItem({ thread, isActive }: { thread: Thread; isActive: boolean }) {
  const setActiveThread = useAppStore((s) => s.setActiveThread)

  return (
    <button
      onClick={() => setActiveThread(thread.id)}
      className="w-full text-left px-3 py-2 rounded-lg transition-colors no-drag"
      style={{
        background: isActive ? 'rgba(0,0,0,0.07)' : 'transparent',
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
        style={{ color: isActive ? '#1c1c1e' : '#3a3a3c' }}
      >
        {thread.title}
      </span>
    </button>
  )
}

export function ThreadList() {
  const threads = useAppStore((s) => s.threads)
  const activeThreadId = useAppStore((s) => s.activeThreadId)

  return (
    <div className="flex-1 overflow-y-auto px-2 py-1">
      {threads.map((thread) => (
        <ThreadListItem key={thread.id} thread={thread} isActive={thread.id === activeThreadId} />
      ))}
    </div>
  )
}
