import type { Thread } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'

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
          <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
            Archived threads
          </div>
          <div className="mt-2 text-sm leading-6" style={{ color: theme.text.muted }}>
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
          background: theme.background.surfaceLightest,
          border: `1px solid ${theme.border.default}`,
          boxShadow: theme.shadow.card
        }}
      >
        <div
          className="text-xs font-semibold tracking-[0.18em] uppercase"
          style={{ color: theme.text.placeholder }}
        >
          Archived
        </div>
        <div className="mt-3 text-xl font-semibold" style={{ color: theme.text.primary }}>
          {activeThread.title}
        </div>
        <div className="mt-3 text-sm leading-6" style={{ color: theme.text.secondary }}>
          {activeThread.preview?.trim() || 'No preview available for this thread.'}
        </div>
        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={() => void onRestoreThread(activeThread)}
            className="rounded-full px-4 py-2 text-sm font-medium"
            style={{
              background: theme.text.primary,
              color: theme.background.canvas
            }}
          >
            Restore
          </button>
          <button
            onClick={() => void onDeleteThread(activeThread)}
            className="rounded-full px-4 py-2 text-sm font-medium"
            style={{
              background: theme.background.dangerSurface,
              color: theme.text.dangerStrong,
              border: `1px solid ${theme.border.danger}`
            }}
          >
            Delete permanently
          </button>
        </div>
      </div>
    </div>
  )
}
