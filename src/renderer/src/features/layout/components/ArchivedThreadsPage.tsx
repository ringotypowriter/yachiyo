/**
 * Read-only viewer for archived threads.
 *
 * Renders a chronological message timeline (reusing the same read-only bubble
 * layout as ExternalThreadViewer) with Restore / Delete actions in a compact
 * action bar. Messages are loaded on demand the first time the thread is selected.
 */

import { useMemo, useEffect, useRef, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import type { Thread, Message, ToolCall } from '@renderer/app/types'
import type { ScheduleRunRecord } from '../../../../../shared/yachiyo/protocol.ts'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { theme, alpha } from '@renderer/theme/theme'
import { MessageMarkdown } from '@renderer/lib/markdown/MessageMarkdown'
import { collectMessagePath } from '../../../../../shared/yachiyo/threadTree.ts'
import { TimelineScrollbar } from '@renderer/features/chat/components/TimelineScrollbar'
import { ToolCallRow } from '@renderer/features/chat/components/ToolCallRow'

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

  return (
    <ArchivedTimeline
      key={activeThread.id}
      threadId={activeThread.id}
      headMessageId={activeThread.headMessageId}
    />
  )
}

const EMPTY_MESSAGES: Message[] = []
const EMPTY_TOOL_CALLS: ToolCall[] = []

function ArchivedTimeline({
  threadId,
  headMessageId
}: {
  threadId: string
  headMessageId?: string
}): React.JSX.Element {
  const messages = useAppStore((state) => state.messages[threadId] ?? EMPTY_MESSAGES)
  const toolCalls = useAppStore((state) => state.toolCalls[threadId] ?? EMPTY_TOOL_CALLS)
  const [scheduleRun, setScheduleRun] = useState<ScheduleRunRecord | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Fetch on mount only — the parent remounts via key={threadId} so a new
  // archived thread always starts with a fresh local state.
  useEffect(() => {
    let cancelled = false
    void window.api.yachiyo.loadThreadData({ threadId }).then((data) => {
      if (cancelled) return
      setScheduleRun(data.scheduleRun ?? null)
      useAppStore.setState((state) => ({
        messages: { ...state.messages, [threadId]: data.messages },
        toolCalls: { ...state.toolCalls, [threadId]: data.toolCalls }
      }))
    })
    return () => {
      cancelled = true
    }
  }, [threadId])

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

  // Group tool calls by the assistant message they belong to so each branch in
  // a multi-reply thread shows its own execution history. Tool calls written
  // before assistantMessageId existed fall back to the requestMessageId map,
  // which is keyed off the user message that triggered the run.
  const { toolCallsByAssistantId, toolCallsByRequestIdLegacy } = useMemo(() => {
    const byAssistant = new Map<string, ToolCall[]>()
    const byRequest = new Map<string, ToolCall[]>()
    for (const tc of toolCalls) {
      if (tc.assistantMessageId) {
        const list = byAssistant.get(tc.assistantMessageId)
        if (list) list.push(tc)
        else byAssistant.set(tc.assistantMessageId, [tc])
      } else if (tc.requestMessageId) {
        const list = byRequest.get(tc.requestMessageId)
        if (list) list.push(tc)
        else byRequest.set(tc.requestMessageId, [tc])
      }
    }
    return { toolCallsByAssistantId: byAssistant, toolCallsByRequestIdLegacy: byRequest }
  }, [toolCalls])

  // Empty state: only fall back to the placeholder when there's also no
  // schedule result to show. Failed schedule runs may have no persisted
  // messages but still carry the only useful context for the archived thread.
  if (visibleMessages.length === 0 && !scheduleRun) {
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
            <ReadOnlyAssistantBubble
              key={message.id}
              message={message}
              toolCalls={
                toolCallsByAssistantId.get(message.id) ??
                toolCallsByRequestIdLegacy.get(message.parentMessageId ?? '') ??
                EMPTY_TOOL_CALLS
              }
            />
          )
        )}
        {scheduleRun && <ScheduleSummaryCard run={scheduleRun} />}
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

function ReadOnlyAssistantBubble({
  message,
  toolCalls
}: {
  message: Message
  toolCalls: ToolCall[]
}): React.JSX.Element {
  const hasContent = !!message.content?.trim()
  const hasImages = message.images && message.images.length > 0
  const hasToolCalls = toolCalls.length > 0

  if (!hasContent && !hasImages && !hasToolCalls) return <></>

  return (
    <div className="flex flex-col gap-0 py-1" data-message-id={message.id}>
      {toolCalls.map((tc) => (
        <ToolCallRow key={tc.id} toolCall={tc} />
      ))}
      {(hasContent || hasImages) && (
        <div className="px-6">
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
      )}
    </div>
  )
}

function formatDuration(startedAt: string, completedAt?: string): string | null {
  if (!completedAt) return null
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
}

function formatRunTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function ScheduleSummaryCard({ run }: { run: ScheduleRunRecord }): React.JSX.Element {
  // Prefer the agent-reported result status; fall back to the run's lifecycle
  // status (failed/skipped) so cancelled or pre-failure runs still render.
  const reported = run.resultStatus
  const isSuccess = reported === 'success' || (!reported && run.status === 'completed')
  const isFailure = reported === 'failure' || run.status === 'failed' || run.status === 'skipped'
  const accent = isSuccess
    ? theme.status.success
    : isFailure
      ? theme.status.danger
      : theme.status.idle
  const label = reported ?? run.status
  const summaryText = run.resultSummary ?? run.error ?? null
  const duration = formatDuration(run.startedAt, run.completedAt)
  const Icon = isSuccess ? CheckCircle2 : isFailure ? XCircle : CheckCircle2

  return (
    <div className="px-6 mt-4 mb-2">
      <div
        className="rounded-2xl px-5 py-4 flex flex-col gap-3"
        style={{
          background: alpha('ink', 0.02),
          border: `1px solid ${alpha('ink', 0.06)}`,
          boxShadow: theme.shadow.card
        }}
      >
        <div className="flex items-center gap-2">
          <Icon size={16} style={{ color: accent }} />
          <span className="text-sm font-semibold" style={{ color: theme.text.primary }}>
            Schedule result
          </span>
          <span
            className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded-full font-medium"
            style={{
              background: alpha('ink', 0.05),
              color: accent
            }}
          >
            {label}
          </span>
        </div>
        {summaryText && (
          <p
            className="text-sm leading-relaxed whitespace-pre-wrap m-0"
            style={{ color: theme.text.primary }}
          >
            {summaryText}
          </p>
        )}
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
          style={{ color: theme.text.muted }}
        >
          <span>Started {formatRunTimestamp(run.startedAt)}</span>
          {run.completedAt && <span>· Finished {formatRunTimestamp(run.completedAt)}</span>}
          {duration && <span>· {duration}</span>}
          {(run.promptTokens != null || run.completionTokens != null) && (
            <span>· {(run.promptTokens ?? 0) + (run.completionTokens ?? 0)} tokens</span>
          )}
        </div>
      </div>
    </div>
  )
}
