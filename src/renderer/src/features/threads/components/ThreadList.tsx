import type React from 'react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { Thread } from '@renderer/app/types'

function ThreadListItem({
  thread,
  isActive
}: {
  thread: Thread
  isActive: boolean
}): React.JSX.Element {
  const setActiveThread = useAppStore((s) => s.setActiveThread)
  const preview = thread.preview?.trim() || 'No messages yet'

  return (
    <button
      onClick={() => setActiveThread(thread.id)}
      className="w-full text-left px-3 py-2.5 rounded-lg transition-colors no-drag"
      style={{
        background: isActive ? 'rgba(0,0,0,0.07)' : 'transparent'
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
      <span
        className="mt-0.5 block text-xs truncate"
        style={{ color: isActive ? '#5b5a57' : '#8e8e93' }}
      >
        {preview}
      </span>
    </button>
  )
}

export function ThreadList(): React.JSX.Element {
  const threads = useAppStore((s) => s.threads)
  const activeThreadId = useAppStore((s) => s.activeThreadId)

  return (
    <div className="flex-1 overflow-y-auto px-2 py-1">
      {threads.length === 0 ? (
        <div className="px-4 py-6 text-sm leading-6" style={{ color: '#8e8e93' }}>
          No chats yet. Start one from the compose box or the new chat button.
        </div>
      ) : null}
      {threads.map((thread) => (
        <ThreadListItem key={thread.id} thread={thread} isActive={thread.id === activeThreadId} />
      ))}
    </div>
  )
}
