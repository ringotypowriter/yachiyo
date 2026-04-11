/**
 * Read-only viewer for external channel threads (Telegram, etc.).
 *
 * Renders a chronological message list with tool call rows, no action bars,
 * no branching, and no composer. For assistant messages, shows `visibleReply`
 * (the extracted clean text the channel user actually received) when available.
 */

import type React from 'react'
import { useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { Message, ToolCall } from '@renderer/app/types'
import { theme } from '@renderer/theme/theme'
import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'
import type { MarkdownImageContextValue } from '@renderer/lib/markdown/MarkdownImage'
import { ToolCallRow } from './ToolCallRow.tsx'

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

function ExternalAssistantBubble({
  message,
  toolCalls
}: {
  message: Message
  toolCalls: ToolCall[]
}): React.JSX.Element {
  const content = message.visibleReply ?? message.content
  const imageContext = useMemo<MarkdownImageContextValue>(
    () => ({ threadId: message.threadId, messageId: message.id }),
    [message.id, message.threadId]
  )

  return (
    <div className="flex flex-col gap-0 px-0 py-1">
      {toolCalls.map((tc) => (
        <ToolCallRow key={tc.id} toolCall={tc} />
      ))}
      {content.trim() ? (
        <div className="px-6">
          <div className="w-full">
            <div className="assistant-message-bubble">
              <MessageMarkdown content={content} isStreaming={false} imageContext={imageContext} />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

const EMPTY_MESSAGES: Message[] = []
const EMPTY_TOOL_CALLS: ToolCall[] = []

export function ExternalThreadViewer({ threadId }: { threadId: string | null }): React.JSX.Element {
  const messages = useAppStore((state) =>
    threadId ? (state.messages[threadId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const toolCalls = useAppStore((state) =>
    threadId ? (state.toolCalls[threadId] ?? EMPTY_TOOL_CALLS) : EMPTY_TOOL_CALLS
  )
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

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

  // Build a map of tool calls keyed by their request message ID for grouping
  // with the corresponding assistant response.
  const toolCallsByRequestId = new Map<string, ToolCall[]>()
  for (const tc of toolCalls) {
    const key = tc.requestMessageId ?? ''
    const list = toolCallsByRequestId.get(key)
    if (list) {
      list.push(tc)
    } else {
      toolCallsByRequestId.set(key, [tc])
    }
  }

  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden py-4">
      {visibleMessages.map((message) =>
        message.role === 'user' ? (
          <ExternalUserBubble key={message.id} message={message} />
        ) : (
          <ExternalAssistantBubble
            key={message.id}
            message={message}
            toolCalls={toolCallsByRequestId.get(message.parentMessageId ?? '') ?? EMPTY_TOOL_CALLS}
          />
        )
      )}
      <div ref={bottomRef} />
    </div>
  )
}
