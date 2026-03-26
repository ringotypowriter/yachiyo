import type React from 'react'
import { FileText } from 'lucide-react'
import type { Message } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import { canRetryUserMessage } from '../lib/messageActionState'
import { MessageActionBar } from './MessageActionBar'

function UserMessageImages({ message }: { message: Message }): React.JSX.Element | null {
  if (!message.images || message.images.length === 0) {
    return null
  }

  return (
    <div className="user-message-images">
      {message.images.map((image, index) => (
        <div key={`${image.filename ?? 'image'}-${index}`} className="user-message-images__item">
          <img
            className="user-message-images__media"
            src={image.dataUrl}
            alt={image.filename ?? `Image ${index + 1}`}
          />
        </div>
      ))}
    </div>
  )
}

function UserMessageFiles({ message }: { message: Message }): React.JSX.Element | null {
  if (!message.attachments || message.attachments.length === 0) {
    return null
  }

  return (
    <div className="user-message-files">
      {message.attachments.map((attachment, index) => (
        <div key={`${attachment.filename}-${index}`} className="user-message-file-chip">
          <FileText size={13} strokeWidth={1.5} className="user-message-file-chip__icon" />
          <span className="user-message-file-chip__name">{attachment.filename}</span>
        </div>
      ))}
    </div>
  )
}

interface UserMessageBubbleProps {
  label?: string
  message: Message
  pending?: boolean
  threadHasActiveRun?: boolean
  onEdit?: () => void
  onRetry?: () => Promise<void> | void
  onCreateBranch: () => Promise<void> | void
  onDelete: () => Promise<void> | void
}

export function UserMessageBubble({
  label,
  message,
  pending = false,
  threadHasActiveRun = false,
  onEdit,
  onRetry,
  onCreateBranch,
  onDelete
}: UserMessageBubbleProps): React.JSX.Element {
  const canRetry = canRetryUserMessage({ threadHasActiveRun })

  return (
    <div className="flex justify-end px-6 py-1">
      <div className="max-w-[68%] message-card-shell">
        <div
          className="rounded-[18px] px-4 py-2.5 message-selectable"
          style={{ background: theme.text.accent, color: theme.text.inverse }}
        >
          {label ? (
            <div
              className="mb-2 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium"
              style={{ background: theme.background.surfaceOverlay }}
            >
              {label}
            </div>
          ) : null}
          <UserMessageImages message={message} />
          <UserMessageFiles message={message} />
          {message.content ? (
            <p
              className={`leading-relaxed whitespace-pre-wrap m-0${message.images?.length || message.attachments?.length ? ' mt-3' : ''}`}
              style={{
                fontSize: 'calc(var(--yachiyo-font-size-chat, 14px) / var(--yachiyo-ui-zoom, 1))'
              }}
            >
              {message.content}
            </p>
          ) : null}
        </div>
        {!pending ? (
          <div className="mt-2 flex justify-end">
            <MessageActionBar
              content={message.content}
              canRetry={canRetry}
              onEdit={onEdit}
              onRetry={onRetry}
              onCreateBranch={onCreateBranch}
              onDelete={onDelete}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}
