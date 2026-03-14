import type React from 'react'
import { useEffect, useRef } from 'react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { UserMessageBubble } from './UserMessageBubble'
import { AssistantMessageBubble } from './AssistantMessageBubble'
import type { Message } from '@renderer/app/types'

interface MessageTimelineProps {
  threadId: string | null
}

const EMPTY: Message[] = []

export function MessageTimeline({ threadId }: MessageTimelineProps): React.JSX.Element {
  const messages = useAppStore((s) => (threadId ? (s.messages[threadId] ?? EMPTY) : EMPTY))
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (!threadId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm" style={{ color: '#8a8680' }}>
          Start a new thread or type below to create one automatically.
        </p>
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm" style={{ color: '#aaa' }}>
          No messages yet
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto py-4">
      {messages.map((msg) =>
        msg.role === 'user' ? (
          <UserMessageBubble key={msg.id} message={msg} />
        ) : (
          <AssistantMessageBubble key={msg.id} message={msg} />
        )
      )}
      <div ref={bottomRef} />
    </div>
  )
}
