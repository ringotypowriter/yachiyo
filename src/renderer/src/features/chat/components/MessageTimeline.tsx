import type React from 'react'
import { useEffect, useRef } from 'react'
import { useAppStore } from '@renderer/app/store/useAppStore'
import type { HarnessRecord } from '@renderer/app/store/useAppStore'
import { UserMessageBubble } from './UserMessageBubble'
import { AssistantMessageBubble } from './AssistantMessageBubble'
import { PreparingBubble } from './PreparingBubble'
import { RunEventRow } from './RunEventRow'
import type { Message } from '@renderer/app/types'

interface MessageTimelineProps {
  threadId: string | null
}

const EMPTY_MESSAGES: Message[] = []
const EMPTY_HARNESSES: HarnessRecord[] = []

// default.reply is implicit in the message bubble — don't show a separate row for it
const DEFAULT_HARNESS = 'default.reply'

type TimelineItem =
  | { kind: 'message'; key: string; time: string; data: Message }
  | { kind: 'harness'; key: string; time: string; data: HarnessRecord }

function buildTimeline(messages: Message[], harnesses: HarnessRecord[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...messages.map((m) => ({ kind: 'message' as const, key: m.id, time: m.createdAt, data: m })),
    ...harnesses
      .filter((h) => h.name !== DEFAULT_HARNESS)
      .map((h) => ({ kind: 'harness' as const, key: h.id, time: h.startedAt, data: h }))
  ]
  return items.sort((a, b) => a.time.localeCompare(b.time))
}

export function MessageTimeline({ threadId }: MessageTimelineProps): React.JSX.Element {
  const messages = useAppStore((s) =>
    threadId ? (s.messages[threadId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  const harnessEvents = useAppStore((s) =>
    threadId ? (s.harnessEvents[threadId] ?? EMPTY_HARNESSES) : EMPTY_HARNESSES
  )
  const activeRunThreadId = useAppStore((s) => s.activeRunThreadId)
  const runPhase = useAppStore((s) => s.runPhase)
  const bottomRef = useRef<HTMLDivElement>(null)

  const showPreparingBubble =
    runPhase === 'preparing' && threadId !== null && activeRunThreadId === threadId

  const timeline = buildTimeline(messages, harnessEvents)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, harnessEvents, showPreparingBubble])

  if (!threadId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm" style={{ color: '#8a8680' }}>
          Start a new thread or type below to create one automatically.
        </p>
      </div>
    )
  }

  if (timeline.length === 0 && !showPreparingBubble) {
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
      {timeline.map((item) => {
        if (item.kind === 'harness') {
          return <RunEventRow key={item.key} harness={item.data} />
        }
        const msg = item.data
        return msg.role === 'user' ? (
          <UserMessageBubble key={item.key} message={msg} />
        ) : (
          <AssistantMessageBubble key={item.key} message={msg} />
        )
      })}
      {showPreparingBubble && <PreparingBubble />}
      <div ref={bottomRef} />
    </div>
  )
}
