import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, ChevronUp, Square, Terminal, X } from 'lucide-react'

import { theme } from '@renderer/theme/theme'
import { useBackgroundTasksStore, type BackgroundTaskState } from '../state/useBackgroundTasksStore'
import { BACKGROUND_TASK_LOG_DEFAULT_MAX_BYTES } from '../../../../../shared/yachiyo/protocol.ts'

interface BackgroundTasksChipProps {
  threadId: string | null
}

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

function useNowTick(intervalMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, enabled])
  return now
}

export function BackgroundTasksChip({
  threadId
}: BackgroundTasksChipProps): React.JSX.Element | null {
  // Select the raw per-thread map so the snapshot is referentially stable; the
  // map only changes when a task is added/updated/removed for this thread.
  const taskMap = useBackgroundTasksStore((s) => (threadId ? s.tasksByThread[threadId] : undefined))
  const tasks = useMemo<BackgroundTaskState[]>(() => {
    if (!taskMap) return []
    return Object.values(taskMap).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }, [taskMap])
  const runningCount = useMemo(() => tasks.filter((t) => t.status === 'running').length, [tasks])
  const [openRequested, setOpen] = useState(false)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)

  if (tasks.length === 0) return null

  // Derived: only render the panel when there's something to show. No effect
  // needed — the unmount happens naturally when `tasks.length` goes to zero.
  const open = openRequested && tasks.length > 0

  const label =
    runningCount > 0
      ? `${runningCount} background task${runningCount === 1 ? '' : 's'} running`
      : `${tasks.length} background task${tasks.length === 1 ? '' : 's'}`

  return (
    <div
      ref={wrapperRef}
      className="absolute z-20"
      style={{ bottom: '100%', right: 16, marginBottom: 8 }}
    >
      <AnimatePresence>
        {open && (
          <motion.div
            key="bg-tasks-panel"
            initial={{ opacity: 0, scale: 0.95, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 4 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="absolute right-0"
            style={{ bottom: '100%', marginBottom: 8 }}
          >
            <BackgroundTasksPanel
              threadId={threadId ?? ''}
              tasks={tasks}
              expandedTaskId={expandedTaskId}
              onToggleExpand={(id) => setExpandedTaskId((cur) => (cur === id ? null : id))}
              onClose={() => setOpen(false)}
              ignoreClickOutsideRef={wrapperRef}
            />
          </motion.div>
        )}
      </AnimatePresence>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-full cursor-pointer transition-opacity hover:opacity-90"
        style={{
          background: theme.background.surfaceFrosted,
          color: theme.text.primary,
          border: `1px solid ${theme.border.default}`,
          boxShadow: theme.shadow.card,
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)'
        }}
      >
        {runningCount > 0 ? (
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{
              background: theme.text.accent,
              animation: 'yachiyo-preparing-pulse 1.2s ease-in-out infinite'
            }}
          />
        ) : (
          <Terminal size={12} strokeWidth={1.75} />
        )}
        <span>{label}</span>
        {open ? (
          <ChevronDown size={12} strokeWidth={1.75} />
        ) : (
          <ChevronUp size={12} strokeWidth={1.75} />
        )}
      </button>
    </div>
  )
}

interface BackgroundTasksPanelProps {
  threadId: string
  tasks: BackgroundTaskState[]
  expandedTaskId: string | null
  onToggleExpand: (taskId: string) => void
  onClose: () => void
  ignoreClickOutsideRef: React.RefObject<HTMLDivElement | null>
}

function BackgroundTasksPanel({
  threadId,
  tasks,
  expandedTaskId,
  onToggleExpand,
  onClose,
  ignoreClickOutsideRef
}: BackgroundTasksPanelProps): React.JSX.Element {
  const dismissTask = useBackgroundTasksStore((s) => s.dismissTask)
  const dismissAllFinished = useBackgroundTasksStore((s) => s.dismissAllFinished)
  const finishedCount = tasks.filter((t) => t.status !== 'running').length
  const ref = useRef<HTMLDivElement>(null)
  const hasRunning = tasks.some((t) => t.status === 'running')
  const now = useNowTick(1000, hasRunning)

  // Click outside to dismiss. The chip wrapper is treated as "inside" so the
  // toggle button doesn't trigger close-then-reopen on the same click.
  useEffect(() => {
    const handler = (e: MouseEvent): void => {
      const target = e.target as Node
      if (ref.current?.contains(target)) return
      if (ignoreClickOutsideRef.current?.contains(target)) return
      onClose()
    }
    const id = setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => {
      clearTimeout(id)
      document.removeEventListener('mousedown', handler)
    }
  }, [onClose, ignoreClickOutsideRef])

  // Sort: running first (oldest first), then completed (newest first).
  const sorted = useMemo(() => {
    const running = tasks.filter((t) => t.status === 'running')
    const finished = tasks
      .filter((t) => t.status !== 'running')
      .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
    return [...running, ...finished]
  }, [tasks])

  return (
    <div
      ref={ref}
      className="mb-2 rounded-xl overflow-hidden flex flex-col"
      style={{
        width: 'min(760px, calc(100vw - 32px))',
        maxHeight: 'min(78vh, 680px)',
        background: theme.background.surfaceFrosted,
        border: `1px solid ${theme.border.default}`,
        boxShadow: theme.shadow.card,
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)'
      }}
    >
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: `1px solid ${theme.border.default}` }}
      >
        <div className="text-xs font-semibold" style={{ color: theme.text.primary }}>
          Background tasks
        </div>
        <div className="flex items-center gap-2">
          {finishedCount > 0 && (
            <button
              type="button"
              onClick={() => dismissAllFinished(threadId)}
              className="text-[10px] cursor-pointer hover:opacity-70"
              style={{ color: theme.text.muted }}
            >
              Clear {finishedCount} done
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Collapse"
            className="p-1 rounded cursor-pointer hover:opacity-70"
            style={{ color: theme.icon.default }}
          >
            <ChevronDown size={12} strokeWidth={1.75} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sorted.map((task) => (
          <BackgroundTaskRow
            key={task.taskId}
            task={task}
            expanded={expandedTaskId === task.taskId}
            onToggleExpand={() => onToggleExpand(task.taskId)}
            onCancel={() => void window.api.yachiyo.cancelBackgroundTask({ taskId: task.taskId })}
            onDismiss={() => dismissTask(threadId, task.taskId)}
            now={now}
          />
        ))}
      </div>
    </div>
  )
}

interface BackgroundTaskRowProps {
  task: BackgroundTaskState
  expanded: boolean
  onToggleExpand: () => void
  onCancel: () => void
  onDismiss: () => void
  now: number
}

function BackgroundTaskRow({
  task,
  expanded,
  onToggleExpand,
  onCancel,
  onDismiss,
  now
}: BackgroundTaskRowProps): React.JSX.Element {
  const isRunning = task.status === 'running'
  const isFailed = task.status === 'failed'
  const isCancelled = task.cancelledByUser === true
  const statusColor = isRunning
    ? theme.text.accent
    : isFailed
      ? theme.text.danger
      : theme.text.success
  const statusLabel = isRunning
    ? formatElapsed(task.startedAt, now)
    : isCancelled
      ? 'cancelled'
      : isFailed
        ? `failed (exit ${task.exitCode ?? '?'})`
        : `done (exit ${task.exitCode ?? 0})`

  return (
    <div style={{ borderBottom: `1px solid ${theme.border.subtle}` }}>
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex-1 flex items-center gap-2 min-w-0 text-left cursor-pointer hover:opacity-80"
        >
          <span
            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
            style={{
              background: statusColor,
              animation: isRunning ? 'yachiyo-preparing-pulse 1.2s ease-in-out infinite' : undefined
            }}
          />
          <code
            className="flex-1 min-w-0 text-xs truncate font-mono"
            style={{ color: theme.text.primary, maxWidth: 420 }}
            title={task.command}
          >
            {task.command}
          </code>
          <span className="text-[10px] tabular-nums" style={{ color: theme.text.muted }}>
            {statusLabel}
          </span>
        </button>
        {isRunning ? (
          <button
            type="button"
            onClick={onCancel}
            title="Cancel task"
            className="p-1 rounded cursor-pointer hover:opacity-70 shrink-0"
            style={{ color: theme.text.danger }}
          >
            <Square size={10} strokeWidth={2} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onDismiss}
            title="Dismiss"
            className="p-1 rounded cursor-pointer hover:opacity-70 shrink-0"
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
          const message = error instanceof Error ? error.message : 'Could not load full log.'
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
  }, [task.threadId, task.taskId, task.status])

  const fallbackTail = linesToText(task.logTail)
  const logContent = logState.content || fallbackTail
  const logStatus =
    logState.status === 'failed'
      ? logState.message
      : logState.status === 'loading'
        ? 'Loading full log...'
        : logState.truncated
          ? `Showing last ${formatByteCount(logState.totalBytes - logState.startByte)} of ${formatByteCount(logState.totalBytes)}`
          : undefined

  return (
    <div className="yachiyo-detail-reveal flex flex-col gap-2 px-3 pb-3">
      <BackgroundTaskCommandView command={task.command} />
      <BackgroundTaskLogView content={logContent} statusText={logStatus} />
    </div>
  )
}

function BackgroundTaskCommandView({ command }: { command: string }): React.JSX.Element {
  return (
    <section>
      <div className="mb-1 text-[10px] font-medium" style={{ color: theme.text.placeholder }}>
        Full command
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
        <span style={{ color: theme.text.placeholder }}>Log output</span>
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
        {content ? content : <span style={{ color: theme.text.muted }}>(no output yet)</span>}
      </div>
    </section>
  )
}
