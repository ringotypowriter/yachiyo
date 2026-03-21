import type { Thread } from '@renderer/app/types'

export interface ArchivedThreadsPageProps {
  activeThread: Thread | null
  onDeleteThread: (thread: Thread) => Promise<void>
  onRestoreThread: (thread: Thread) => Promise<void>
}

export function ArchivedThreadsPage({
  activeThread,
  onDeleteThread,
  onRestoreThread
}: ArchivedThreadsPageProps): React.JSX.Element {
  if (!activeThread) {
    return (
      <div className="flex flex-1 items-center justify-center px-8">
        <div className="max-w-md text-center">
          <div className="text-sm font-semibold" style={{ color: '#2D2D2B' }}>
            Archived threads
          </div>
          <div className="mt-2 text-sm leading-6" style={{ color: '#8e8e93' }}>
            Select an archived thread from the sidebar to restore it or delete it permanently.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 items-center justify-center px-8">
      <div
        className="w-full max-w-xl rounded-3xl p-6"
        style={{
          background: 'rgba(255,255,255,0.72)',
          border: '1px solid rgba(0,0,0,0.06)',
          boxShadow: '0 18px 40px rgba(0,0,0,0.05)'
        }}
      >
        <div
          className="text-xs font-semibold tracking-[0.18em] uppercase"
          style={{ color: '#aaa9a4' }}
        >
          Archived
        </div>
        <div className="mt-3 text-xl font-semibold" style={{ color: '#2D2D2B' }}>
          {activeThread.title}
        </div>
        <div className="mt-3 text-sm leading-6" style={{ color: '#5b5a57' }}>
          {activeThread.preview?.trim() || 'No preview available for this thread.'}
        </div>
        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={() => void onRestoreThread(activeThread)}
            className="rounded-full px-4 py-2 text-sm font-medium"
            style={{
              background: '#2D2D2B',
              color: '#F9F9F7'
            }}
          >
            Restore
          </button>
          <button
            onClick={() => void onDeleteThread(activeThread)}
            className="rounded-full px-4 py-2 text-sm font-medium"
            style={{
              background: 'rgba(142,62,53,0.08)',
              color: '#8E3E35',
              border: '1px solid rgba(142,62,53,0.14)'
            }}
          >
            Delete permanently
          </button>
        </div>
      </div>
    </div>
  )
}
