/**
 * Read-only viewer for archived threads.
 *
 * Renders a chronological message timeline (reusing the same read-only bubble
 * layout as ExternalThreadViewer) with Restore / Delete actions in a compact
 * action bar. Messages are loaded on demand the first time the thread is selected.
 */

import { useMemo, useEffect, useRef } from 'react'
import type { Thread, Message } from '@renderer/app/types'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { theme, alpha } from '@renderer/theme/theme'
import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'
import { collectMessagePath } from '../../../../../shared/yachiyo/threadTree.ts'
import { TimelineScrollbar } from '@renderer/features/chat/components/TimelineScrollbar'

export interface ArchivedThreadsPageProps {
  activeThread: Thread | null
}

export function ArchivedThreadsPage({ activeThread }: ArchivedThreadsPageProps): React.JSX.Element {
  if (!activeThread) {
    return (
      <div className="flex flex-1 items-center justify-center px-8">
        <div className="max-w-md text-center">
          <div className="text-sm font-semibold" style={{ color: theme.text.primary }}>
            Archived threads
          </div>
          <div className="mt-2 text-sm leading-6" style={{ color: theme.text.muted }}>
            Select an archived thread from the sidebar to view it.
          </div>
        </div>
      </div>
    )
  }

  return <ArchivedTimeline threadId={activeThread.id} headMessageId={activeThread.headMessageId} />
}

const EMPTY_MESSAGES: Message[] = []

function ArchivedTimeline({
  threadId,
  headMessageId
}: {
  threadId: string
  headMessageId?: string
}): React.JSX.Element {
  const messages = useAppStore((state) => state.messages[threadId] ?? EMPTY_MESSAGES)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

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
    const container = scrollContainerRef.current
    const bottom = bottomRef.current
    if (!container || !bottom) return

    let rafId: number | null = null
    let rafId2: number | null = null

    rafId = requestAnimationFrame(() => {
      rafId2 = requestAnimationFrame(() => {
        const distanceFromBottom =
          container.scrollHeight - container.scrollTop - container.clientHeight
        if (distanceFromBottom < 100) {
          bottom.scrollIntoView({ behavior: 'smooth', block: 'end' })
        } else {
          container.scrollTop = container.scrollHeight
        }
      })
    })

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
      if (rafId2 !== null) cancelAnimationFrame(rafId2)
    }
  }, [messages])

  // Walk the active branch from headMessageId to show the correct reply path,
  // not every branch. Falls back to flat filter if no head is set.
  const visibleMessages = useMemo(() => {
    if (headMessageId && messages.length > 0) {
      return collectMessagePath(messages, headMessageId).filter(
        (m) => m.role === 'user' || m.role === 'assistant'
      )
    }
    return messages.filter((m) => m.role === 'user' || m.role === 'assistant')
  }, [messages, headMessageId])

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
    <div className="flex-1 relative min-h-0">
      <TimelineScrollbar
        messages={visibleMessages}
        scrollContainerRef={scrollContainerRef}
        onScrollToMessage={(messageId) => {
          const el = document.querySelector(`[data-message-id="${messageId}"]`)
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }}
      />
      <div ref={scrollContainerRef} className="h-full overflow-y-auto overflow-x-hidden py-4">
        {visibleMessages.map((message) =>
          message.role === 'user' ? (
            <ReadOnlyUserBubble key={message.id} message={message} />
          ) : (
            <ReadOnlyAssistantBubble key={message.id} message={message} />
          )
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function ReadOnlyUserBubble({ message }: { message: Message }): React.JSX.Element {
  const hasImages = message.images && message.images.length > 0
  const hasAttachments = message.attachments && message.attachments.length > 0
  const hasContent = !!message.content?.trim()

  if (!hasContent && !hasImages && !hasAttachments) return <></>

  return (
    <div className="flex justify-end px-6 py-1" data-message-id={message.id}>
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
    <div className="flex flex-col gap-2 px-6 py-1" data-message-id={message.id}>
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
