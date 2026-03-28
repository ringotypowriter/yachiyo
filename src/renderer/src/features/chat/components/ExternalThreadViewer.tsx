/**
 * Read-only viewer for external channel threads (Telegram, etc.).
 *
 * Renders a clean chronological message list with no action bars, no branching,
 * and no composer. For assistant messages, shows `visibleReply` (the extracted
 * clean text the channel user actually received) when available.
 */

import type React from 'react'
import { useEffect, useRef } from 'react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { Message } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'

function ExternalUserBubble({ message }: { message: Message }): React.JSX.Element {
  return (
    <div className="flex justify-end px-6 py-1">
      <div className="max-w-[68%]">
        <div
          className="rounded-[18px] px-4 py-2.5"
          style={{ background: theme.text.accent, color: theme.text.inverse }}
        >
          {message.content ? (
            <p
              className="leading-relaxed whitespace-pre-wrap m-0"
              style={{
                fontSize: 'calc(var(--yachiyo-font-size-chat, 14px) / var(--yachiyo-ui-zoom, 1))'
              }}
            >
              {message.content}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ExternalAssistantBubble({ message }: { message: Message }): React.JSX.Element {
  const content = message.visibleReply ?? message.content

  if (!content.trim()) return <></>

  return (
    <div className="flex flex-col gap-2 px-6 py-1">
      <div className="w-full">
        <div className="assistant-message-bubble">
          <MessageMarkdown content={content} isStreaming={false} />
        </div>
      </div>
    </div>
  )
}

const EMPTY_MESSAGES: Message[] = []

export function ExternalThreadViewer({ threadId }: { threadId: string | null }): React.JSX.Element {
  const messages = useAppStore((state) =>
    threadId ? (state.messages[threadId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const bottomRef = useRef<HTMLDivElement>(null)

  // On-demand load for external threads whose messages aren't in memory yet.
  useEffect(() => {
    if (!threadId) return
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

  if (!threadId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm" style={{ color: theme.text.muted }}>
          Select a thread to view
        </p>
      </div>
    )
  }

  const visibleMessages = messages.filter((m) => m.role === 'user' || m.role === 'assistant')

  if (visibleMessages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm" style={{ color: theme.text.placeholder }}>
          No messages yet
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto overflow-x-hidden py-4">
      {visibleMessages.map((message) =>
        message.role === 'user' ? (
          <ExternalUserBubble key={message.id} message={message} />
        ) : (
          <ExternalAssistantBubble key={message.id} message={message} />
        )
      )}
      <div ref={bottomRef} />
    </div>
  )
}
