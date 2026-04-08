import { Ellipsis } from 'lucide-react'
import { useState } from 'react'
import type { Thread } from '@renderer/app/types'
import { ThreadContextMenuPopup } from '@renderer/features/threads/components/ThreadContextMenuPopup'
import {
  resolveThreadContextOperations,
  type ThreadContextOperationKey
} from '@renderer/features/threads/lib/threadContextOperations'
import { theme } from '@renderer/theme/theme'

export interface ThreadHeaderActionsProps {
  activeThread: Thread | null
  isRenameDisabled: boolean
  isRunning?: boolean
  isSaving?: boolean
  isStarred?: boolean
  onSelectOperation: (operationKey: ThreadContextOperationKey) => void
}

function isExternalThread(thread: Thread): boolean {
  return thread.source != null && thread.source !== 'local'
}

export function ThreadHeaderActions({
  activeThread,
  isRenameDisabled,
  isRunning,
  isSaving,
  isStarred,
  onSelectOperation
}: ThreadHeaderActionsProps): React.JSX.Element {
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null)

  if (!activeThread) {
    return <div className="no-drag" />
  }

  const operations = resolveThreadContextOperations({
    isArchived: false,
    isExternal: isExternalThread(activeThread),
    isRenameDisabled,
    isRunning,
    isSaving,
    isStarred
  })

  return (
    <div className="relative flex items-center no-drag">
      <button
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setMenuPosition({
            left: rect.right - 184,
            top: rect.bottom + 8
          })
        }}
        className="rounded-md p-1.5 opacity-50 transition-opacity hover:opacity-90"
        style={{ color: theme.icon.default }}
        title="Thread options"
        aria-label="Thread options"
      >
        <Ellipsis size={18} strokeWidth={1.7} />
      </button>
      {menuPosition ? (
        <ThreadContextMenuPopup
          position={menuPosition}
          operations={operations}
          onClose={() => setMenuPosition(null)}
          onSelect={onSelectOperation}
        />
      ) : null}
    </div>
  )
}
