import React, { memo, useCallback, useState } from 'react'
import { FileText } from 'lucide-react'
import type { Message, Thread } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import { linkifyText } from '@renderer/lib/markdown/linkifyText'
import { ImageDetailViewer } from '@renderer/lib/markdown/ImageDetailViewer'
import { canRetryUserMessage } from '../lib/messageActionState'
import { MessageActionBar } from './MessageActionBar'

function UserMessageImages({ message }: { message: Message }): React.JSX.Element | null {
  const [viewerImage, setViewerImage] = useState<{ src: string; alt: string } | null>(null)

  const handleImageClick = useCallback(
    (src: string, alt: string) => (e: React.MouseEvent) => {
      e.stopPropagation()
      setViewerImage({ src, alt })
    },
    []
  )

  if (!message.images || message.images.length === 0) {
    return null
  }

  return (
    <>
      <div className="user-message-images">
        {message.images.map((image, index) => {
          const alt = image.filename ?? `Image ${index + 1}`
          return (
            <div
              key={`${image.filename ?? 'image'}-${index}`}
              className="user-message-images__item"
            >
              <img
                className="user-message-images__media"
                src={image.dataUrl}
                alt={alt}
                onClick={handleImageClick(image.dataUrl, alt)}
                style={{ cursor: 'pointer' }}
              />
            </div>
          )
        })}
      </div>
      {viewerImage ? (
        <ImageDetailViewer
          src={viewerImage.src}
          alt={viewerImage.alt}
          isOpen
          onClose={() => setViewerImage(null)}
        />
      ) : null}
    </>
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
  threadCapabilities: NonNullable<Thread['capabilities']>
  threadIsSaving?: boolean
  onEdit?: () => void
  onRetry?: () => Promise<void> | void
  onCreateBranch?: () => Promise<void> | void
  onDelete?: () => Promise<void> | void
  onRevert?: () => Promise<void> | void
}

export const UserMessageBubble = memo(function UserMessageBubble({
  label,
  message,
  pending = false,
  threadHasActiveRun = false,
  threadCapabilities,
  threadIsSaving = false,
  onEdit,
  onRetry,
  onCreateBranch,
  onDelete,
  onRevert
}: UserMessageBubbleProps): React.JSX.Element {
  const canRetry = canRetryUserMessage({
    threadCapabilities,
    threadHasActiveRun,
    threadIsSaving
  })

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
                fontFamily: "'Helvetica Neue', 'Segoe UI', sans-serif",
                fontSize: 'calc(var(--yachiyo-font-size-chat, 14px) / var(--yachiyo-ui-zoom, 1))',
                overflowWrap: 'break-word'
              }}
            >
              {linkifyText(message.content)}
            </p>
          ) : null}
        </div>
        {pending ? (
          onRevert ? (
            <div className="mt-2 flex justify-end">
              <MessageActionBar content={message.content} onRevert={onRevert} />
            </div>
          ) : null
        ) : (
          <div className="mt-2 flex justify-end">
            <MessageActionBar
              content={message.content}
              canRetry={canRetry}
              onEdit={onEdit}
              onRetry={onRetry}
              onCreateBranch={onCreateBranch}
              onDelete={onDelete}
              onRevert={onRevert}
            />
          </div>
        )}
      </div>
    </div>
  )
})
