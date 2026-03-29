/**
 * Read-only viewer for archived threads.
 *
 * Renders a chronological message timeline (reusing the same read-only bubble
 * layout as ExternalThreadViewer) with Restore / Delete actions in a compact
 * action bar. Messages are loaded on demand the first time the thread is selected.
 */

import { useEffect, useRef } from 'react'
import type { Thread, Message } from '@renderer/app/types'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { theme, alpha } from '@renderer/theme/theme'
import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'

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
    <div className="flex flex-col flex-1 min-h-0">
      <ArchivedActionBar
        thread={activeThread}
        onRestore={() => void onRestoreThread(activeThread)}
        onDelete={() => void onDeleteThread(activeThread)}
      />
      <ArchivedTimeline threadId={activeThread.id} />
    </div>
  )
}

function ArchivedActionBar({
  thread,
  onRestore,
  onDelete
}: {
  thread: Thread
  onRestore: () => void
  onDelete: () => void
}): React.JSX.Element {
  return (
    <div
      className="flex items-center gap-3 shrink-0 px-5 py-2.5"
      style={{ borderBottom: `1px solid ${theme.border.default}` }}
    >
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate" style={{ color: theme.text.primary }}>
          {thread.title}
        </div>
      </div>
      <button
        onClick={onRestore}
        className="rounded-full px-3.5 py-1.5 text-xs font-medium cursor-pointer"
        style={{
          background: theme.text.primary,
          color: theme.background.canvas
        }}
      >
        Restore
      </button>
      <button
        onClick={onDelete}
        className="rounded-full px-3.5 py-1.5 text-xs font-medium cursor-pointer"
        style={{
          background: theme.background.dangerSurface,
          color: theme.text.dangerStrong,
          border: `1px solid ${theme.border.danger}`
        }}
      >
        Delete
      </button>
    </div>
  )
}

const EMPTY_MESSAGES: Message[] = []

function ArchivedTimeline({ threadId }: { threadId: string }): React.JSX.Element {
  const messages = useAppStore((state) => state.messages[threadId] ?? EMPTY_MESSAGES)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (messages.length > 0) return

    void window.api.yachiyo.loadThreadData({ threadId }).then((data) => {
      useAppStore.setState((state) => ({
        messages: { ...state.messages, [threadId]: data.messages },
        toolCalls: { ...state.toolCalls, [threadId]: data.toolCalls }
      }))
    })
  }, [threadId, messages.length])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const visibleMessages = messages.filter((m) => m.role === 'user' || m.role === 'assistant')

  if (visibleMessages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm" style={{ color: theme.text.placeholder }}>
          No messages
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden py-4">
      {visibleMessages.map((message) =>
        message.role === 'user' ? (
          <ReadOnlyUserBubble key={message.id} message={message} />
        ) : (
          <ReadOnlyAssistantBubble key={message.id} message={message} />
        )
      )}
      <div ref={bottomRef} />
    </div>
  )
}

function ReadOnlyUserBubble({ message }: { message: Message }): React.JSX.Element {
  const hasImages = message.images && message.images.length > 0
  const hasAttachments = message.attachments && message.attachments.length > 0
  const hasContent = !!message.content?.trim()

  if (!hasContent && !hasImages && !hasAttachments) return <></>

  return (
    <div className="flex justify-end px-6 py-1">
      <div className="max-w-[68%]">
        <div
          className="rounded-[18px] px-4 py-2.5"
          style={{ background: alpha('accent', 0.12), color: theme.text.primary }}
        >
          {hasImages &&
            message.images!.map((image, i) => (
              <img
                key={`${image.filename ?? 'img'}-${i}`}
                src={image.dataUrl}
                alt={image.altText ?? image.filename ?? `Image ${i + 1}`}
                className="rounded-lg max-w-full mb-2"
                style={{ maxHeight: 240 }}
              />
            ))}
          {hasAttachments &&
            message.attachments!.map((att, i) => (
              <div
                key={`${att.filename}-${i}`}
                className="text-xs px-2 py-1 rounded mb-2"
                style={{ background: alpha('ink', 0.06) }}
              >
                {att.filename}
              </div>
            ))}
          {hasContent && (
            <p
              className="leading-relaxed whitespace-pre-wrap m-0"
              style={{
                fontSize: 'calc(var(--yachiyo-font-size-chat, 14px) / var(--yachiyo-ui-zoom, 1))'
              }}
            >
              {message.content}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function ReadOnlyAssistantBubble({ message }: { message: Message }): React.JSX.Element {
  const hasContent = !!message.content?.trim()
  const hasImages = message.images && message.images.length > 0

  if (!hasContent && !hasImages) return <></>

  return (
    <div className="flex flex-col gap-2 px-6 py-1">
      <div className="w-full">
        <div className="assistant-message-bubble">
          {hasImages &&
            message.images!.map((image, i) => (
              <img
                key={`${image.filename ?? 'img'}-${i}`}
                src={image.dataUrl}
                alt={image.altText ?? image.filename ?? `Image ${i + 1}`}
                className="rounded-lg max-w-full mb-2"
                style={{ maxHeight: 320 }}
              />
            ))}
          {hasContent && <MessageMarkdown content={message.content} isStreaming={false} />}
        </div>
      </div>
    </div>
  )
}
