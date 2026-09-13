import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Square, Terminal, X } from 'lucide-react'
import { theme } from '@renderer/theme/theme'
import { useT } from '@yachiyo/i18n/react'
import {
  getBackgroundTaskFailureSummary,
  getBackgroundTaskLogContent
} from '../lib/backgroundTaskPresentation'
import type { BackgroundTaskState } from '../state/useBackgroundTasksStore'
import { BACKGROUND_TASK_LOG_DEFAULT_MAX_BYTES } from '@yachiyo/shared/protocol'

function formatElapsed(startedAt: string, now: number): string {
  const start = Date.parse(startedAt)
  if (Number.isNaN(start)) return ''
  const elapsedSec = Math.max(0, Math.floor((now - start) / 1000))
  if (elapsedSec < 60) return `${elapsedSec}s`
  const min = Math.floor(elapsedSec / 60)
  const sec = elapsedSec % 60
  if (min < 60) return `${min}m ${sec}s`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m`
}

interface BackgroundTaskRowProps {
  task: BackgroundTaskState
  expanded: boolean
  onToggleExpand: () => void
  onCancel: () => void
  onDismiss: () => void
  now: number
}

export function BackgroundTaskRow({
  task,
  expanded,
  onToggleExpand,
  onCancel,
  onDismiss,
  now
}: BackgroundTaskRowProps): React.JSX.Element {
  const t = useT()
  const isRunning = task.status === 'running'
  const isFailed = task.status === 'failed'
  const isCancelled = task.cancelledByUser === true
  const statusColor = isRunning
    ? theme.text.accent
    : isFailed
      ? theme.text.danger
      : theme.text.success
  const failureSummary = getBackgroundTaskFailureSummary(task)
  const statusLabel = isRunning
    ? formatElapsed(task.startedAt, now)
    : isCancelled
      ? t('chat.backgroundTasks.statusCancelled')
      : isFailed
        ? failureSummary.kind === 'exit-code'
          ? t('chat.backgroundTasks.statusFailed', { code: failureSummary.exitCode })
          : failureSummary.kind === 'error'
            ? failureSummary.message
            : t('chat.backgroundTasks.statusFailed', { code: '?' })
        : t('chat.backgroundTasks.statusDone', { code: task.exitCode ?? 0 })

  const label = task.description?.trim() || task.command

  return (
    <div style={{ borderBottom: `1px solid ${theme.border.subtle}` }}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex-1 flex items-center gap-2 min-w-0 text-left hover:opacity-80"
        >
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
              isRunning ? 'yachiyo-running-pulse' : ''
            }`}
            style={{ background: statusColor }}
          />
          <Terminal size={12} className="shrink-0" aria-label="Shell command" />
          <span
            className="flex-1 min-w-0 text-xs truncate"
            style={{ color: theme.text.primary, maxWidth: 420 }}
            title={label}
          >
            {label}
          </span>
          <span
            className="max-w-60 truncate text-[10px] tabular-nums"
            style={{ color: theme.text.muted }}
            title={failureSummary.kind === 'error' ? failureSummary.message : undefined}
          >
            {statusLabel}
          </span>
        </button>
        {isRunning ? (
          <button
            type="button"
            onClick={onCancel}
            title={t('chat.backgroundTasks.cancelTask')}
            className="p-1 rounded hover:opacity-70 shrink-0"
            style={{ color: theme.text.danger }}
          >
            <Square size={10} strokeWidth={2} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onDismiss}
            title={t('chat.dismiss')}
            className="p-1 rounded hover:opacity-70 shrink-0"
            style={{ color: theme.icon.default }}
          >
            <X size={11} strokeWidth={1.75} />
          </button>
        )}
      </div>
      {expanded && <BackgroundTaskExpandedView task={task} />}
    </div>
  )
}

type FullLogState =
  | { status: 'loading'; content: string; truncated: false; totalBytes: 0; startByte: 0 }
  | {
      status: 'ready'
      content: string
      truncated: boolean
      totalBytes: number
      startByte: number
    }
  | {
      status: 'failed'
      content: string
      truncated: false
      totalBytes: 0
      startByte: 0
      message: string
    }

function linesToText(lines: string[]): string {
  return lines.join('\n')
}

function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`
    value /= 1024
  }
  return `${value.toFixed(0)} TB`
}

function BackgroundTaskExpandedView({ task }: { task: BackgroundTaskState }): React.JSX.Element {
  const t = useT()
  const [logState, setLogState] = useState<FullLogState>(() => ({
    status: 'loading',
    content: linesToText(task.logTail),
    truncated: false,
    totalBytes: 0,
    startByte: 0
  }))

  useEffect(() => {
    let cancelled = false
    let inFlight = false

    const loadLogSnapshot = (): void => {
      if (inFlight) return
      inFlight = true
      void window.api.yachiyo
        .getBackgroundTaskLog({
          threadId: task.threadId,
          taskId: task.taskId,
          maxBytes: BACKGROUND_TASK_LOG_DEFAULT_MAX_BYTES
        })
        .then((snapshot) => {
          if (cancelled) return
          setLogState((current) => {
            if (
              current.status === 'ready' &&
              current.content === snapshot.content &&
              current.truncated === snapshot.truncated &&
              current.totalBytes === snapshot.totalBytes &&
              current.startByte === snapshot.startByte
            ) {
              return current
            }
            return {
              status: 'ready',
              content: snapshot.content,
              truncated: snapshot.truncated,
              totalBytes: snapshot.totalBytes,
              startByte: snapshot.startByte
            }
          })
        })
        .catch((error: unknown) => {
          if (cancelled) return
          const message =
            error instanceof Error ? error.message : t('chat.backgroundTasks.loadLogFailed')
          setLogState({
            status: 'failed',
            content: '',
            truncated: false,
            totalBytes: 0,
            startByte: 0,
            message
          })
        })
        .finally(() => {
          inFlight = false
        })
    }

    loadLogSnapshot()

    const intervalId = task.status === 'running' ? setInterval(loadLogSnapshot, 1000) : undefined
    return () => {
      cancelled = true
      if (intervalId) clearInterval(intervalId)
    }
  }, [task.threadId, task.taskId, task.status, t])

  const logContent = getBackgroundTaskLogContent(task, logState.content)
  const logStatus =
    logState.status === 'failed'
      ? logState.message
      : logState.status === 'loading'
        ? t('chat.backgroundTasks.loadingLog')
        : logState.truncated
          ? t('chat.backgroundTasks.showingLast', {
              shown: formatByteCount(logState.totalBytes - logState.startByte),
              total: formatByteCount(logState.totalBytes)
            })
          : undefined

  return (
    <div className="yachiyo-detail-reveal flex flex-col gap-2 px-3 pb-3">
      <BackgroundTaskCommandView command={task.command} />
      <BackgroundTaskLogView content={logContent} statusText={logStatus} />
    </div>
  )
}

function BackgroundTaskCommandView({ command }: { command: string }): React.JSX.Element {
  const t = useT()
  return (
    <section>
      <div className="mb-1 text-[10px] font-medium" style={{ color: theme.text.placeholder }}>
        {t('chat.backgroundTasks.fullCommand')}
      </div>
      <pre
        className="message-selectable overflow-auto rounded-md px-3 py-2 text-[11px] font-mono"
        style={{
          maxHeight: 140,
          background: theme.background.codeBlock,
          border: `1px solid ${theme.border.subtle}`,
          color: theme.text.primary,
          lineHeight: 1.5,
          margin: 0,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}
      >
        {command}
      </pre>
    </section>
  )
}

function BackgroundTaskLogView({
  content,
  statusText
}: {
  content: string
  statusText?: string
}): React.JSX.Element {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickyRef.current = distanceFromBottom < 16
  }, [])

  // Auto-scroll to bottom when sticky and new lines arrive.
  useLayoutEffect(() => {
    if (!stickyRef.current) return
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [content])

  return (
    <section>
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-medium">
        <span style={{ color: theme.text.placeholder }}>{t('chat.backgroundTasks.logOutput')}</span>
        {statusText ? <span style={{ color: theme.text.muted }}>{statusText}</span> : null}
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="message-selectable overflow-auto rounded-md px-3 py-2 text-[11px] font-mono"
        style={{
          maxHeight: 'min(420px, 50vh)',
          background: theme.background.codeBlock,
          border: `1px solid ${theme.border.subtle}`,
          color: theme.text.secondary,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}
      >
        {content ? (
          content
        ) : (
          <span style={{ color: theme.text.muted }}>{t('chat.backgroundTasks.noOutputYet')}</span>
        )}
      </div>
    </section>
  )
}
