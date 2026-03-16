import type React from 'react'
import type { Message } from '@renderer/app/types'
import { MessageActionBar } from './MessageActionBar'

interface UserMessageBubbleProps {
  message: Message
  onCreateBranch: () => Promise<void> | void
  onDelete: () => Promise<void> | void
}

export function UserMessageBubble({
  message,
  onCreateBranch,
  onDelete
}: UserMessageBubbleProps): React.JSX.Element {
  return (
    <div className="flex justify-end px-6 py-1">
      <div className="max-w-[68%] message-card-shell">
        <div
          className="rounded-[18px] px-4 py-2.5 message-selectable"
          style={{ background: '#CC7D5E', color: '#fff' }}
        >
          <p className="text-sm leading-relaxed whitespace-pre-wrap m-0">{message.content}</p>
        </div>
        <div className="mt-2 flex justify-end">
          <MessageActionBar
            content={message.content}
            onCreateBranch={onCreateBranch}
            onDelete={onDelete}
          />
        </div>
      </div>
    </div>
  )
}
