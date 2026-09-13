import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, ChevronDown, ChevronUp, Layers, Terminal } from 'lucide-react'
import type { SubagentSnapshot } from '@yachiyo/shared/protocol'
import { useAppStore } from '@renderer/app/store/useAppStore'
import { selectSubagentSnapshotIds } from '@renderer/app/store/useAppStore/helpers'
import { useFloatingPanelLayout } from '@renderer/lib/useFloatingPanelLayout'
import { useRestoreFocusOnUnmount } from '@renderer/lib/focusRestore'
import { theme } from '@renderer/theme/theme'
import { useBackgroundTasksStore, type BackgroundTaskState } from '../state/useBackgroundTasksStore'
import { isTaskRunning, sortTasks, summarizeTasks } from '../lib/taskShelf'
import { AgentTaskRow } from './AgentTaskRow'
import { BackgroundTaskRow } from './BackgroundTaskRow'

type TaskEntry = { state: string; time: string } & (
  | { kind: 'shell'; task: BackgroundTaskState }
  | { kind: 'agent'; task: SubagentSnapshot }
)

export function TasksChip({ threadId }: { threadId: string | null }): React.JSX.Element | null {
  const taskMap = useBackgroundTasksStore((s) => (threadId ? s.tasksByThread[threadId] : undefined))
  const ids = useAppStore((s) => selectSubagentSnapshotIds(s, threadId))
  const snapshots = useAppStore((s) => s.subagentSnapshotsById)
  const [open, setOpen] = useState(false)
  const anchorRef = useRef<HTMLDivElement>(null)
  const entries = useMemo(
    () =>
      sortTasks<TaskEntry>([
        ...Object.values(taskMap ?? {}).map((task): TaskEntry => ({
          kind: 'shell',
          task,
          state: task.status,
          time: task.finishedAt ?? task.startedAt
        })),
        ...ids.flatMap((id): TaskEntry[] => {
          const task = snapshots[id]
          return task
            ? [
                {
                  kind: 'agent',
                  task,
                  state: task.state,
                  time: isTaskRunning(task.state) ? task.startedAt : task.updatedAt
                }
              ]
            : []
        })
      ]),
    [taskMap, ids, snapshots]
  )
  if (!entries.length) return null
  const hasShell = entries.some((entry) => entry.kind === 'shell')
  const hasAgent = entries.some((entry) => entry.kind === 'agent')
  const Icon = hasShell && hasAgent ? Layers : hasShell ? Terminal : Bot
  const running = entries.some((entry) => isTaskRunning(entry.state))
  return (
    <div ref={anchorRef} style={{ minWidth: 0, pointerEvents: 'auto' }}>
      <button
        type="button"
        className="composer-task-chip-button"
        onClick={() => setOpen(!open)}
        data-open={open || undefined}
        data-running={running || undefined}
        aria-expanded={open}
        aria-label="Tasks"
        style={{ maxWidth: '100%', whiteSpace: 'nowrap' }}
      >
        <Icon size={12} className="shrink-0" />
        <span className="truncate">{summarizeTasks(entries)}</span>
        {open ? (
          <ChevronDown size={12} className="shrink-0" />
        ) : (
          <ChevronUp size={12} className="shrink-0" />
        )}
      </button>
      {open &&
        createPortal(
          <TasksPanel
            entries={entries}
            threadId={threadId ?? ''}
            anchorRef={anchorRef}
            onClose={() => setOpen(false)}
          />,
          document.body
        )}
    </div>
  )
}

function TasksPanel({
  entries,
  threadId,
  anchorRef,
  onClose
}: {
  entries: TaskEntry[]
  threadId: string
  anchorRef: React.RefObject<HTMLDivElement | null>
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now)
  const activity = useAppStore((s) => s.subagentStateById)
  const cancelSubagent = useAppStore((s) => s.cancelSubagent)
  const closeSubagent = useAppStore((s) => s.closeSubagent)
  const dismissTask = useBackgroundTasksStore((s) => s.dismissTask)
  const dismissAllFinished = useBackgroundTasksStore((s) => s.dismissAllFinished)
  const running = entries.some((entry) => isTaskRunning(entry.state))
  const { style, layout } = useFloatingPanelLayout({
    open: true,
    referenceRef: anchorRef,
    floatingRef: ref,
    width: 760,
    maxHeight: 680,
    preferredPlacement: 'top',
    alignment: 'end'
  })
  useRestoreFocusOnUnmount()
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  useEffect(() => {
    const click = (event: MouseEvent): void => {
      if (
        !cardRef.current?.contains(event.target as Node) &&
        !anchorRef.current?.contains(event.target as Node)
      )
        onClose()
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('mousedown', click)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', click)
      document.removeEventListener('keydown', key)
    }
  }, [anchorRef, onClose])
  return (
    <div
      ref={ref}
      style={{
        ...style,
        height: 680,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: layout?.placement === 'bottom' ? 'flex-start' : 'flex-end',
        zIndex: 120,
        pointerEvents: 'none'
      }}
    >
      <div
        ref={cardRef}
        role="region"
        aria-label="Tasks"
        data-composer-floating-menu
        data-composer-wheel-local-scroll
        className="rounded-xl overflow-hidden flex flex-col"
        style={{
          maxHeight: '100%',
          minHeight: 0,
          background: theme.background.surfaceFrosted,
          border: `1px solid ${theme.border.default}`,
          boxShadow: theme.shadow.card,
          backdropFilter: 'blur(12px)',
          zIndex: 120,
          pointerEvents: 'auto'
        }}
      >
        <div
          className="flex items-center justify-between gap-2 px-3 py-2"
          style={{ borderBottom: `1px solid ${theme.border.default}` }}
        >
          <span className="text-xs font-semibold" style={{ color: theme.text.primary }}>
            Tasks
          </span>
          <div className="flex items-center gap-3">
            {entries.some((entry) => entry.kind === 'shell' && !isTaskRunning(entry.state)) && (
              <button
                type="button"
                className="text-[10px] hover:opacity-70"
                style={{ color: theme.text.muted }}
                onClick={() => dismissAllFinished(threadId)}
              >
                Clear finished commands
              </button>
            )}
            <button
              type="button"
              aria-label="Collapse tasks"
              onClick={onClose}
              style={{ color: theme.icon.default }}
            >
              <ChevronDown size={12} />
            </button>
          </div>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto"
          data-composer-wheel-local-scroll
          style={{ overscrollBehavior: 'contain' }}
        >
          {entries.map((entry) =>
            entry.kind === 'shell' ? (
              <BackgroundTaskRow
                key={`shell:${entry.task.taskId}`}
                task={entry.task}
                now={now}
                expanded={expandedTaskId === entry.task.taskId}
                onToggleExpand={() =>
                  setExpandedTaskId((id) => (id === entry.task.taskId ? null : entry.task.taskId))
                }
                onCancel={() =>
                  void window.api.yachiyo.cancelBackgroundTask({ taskId: entry.task.taskId })
                }
                onDismiss={() => dismissTask(threadId, entry.task.taskId)}
              />
            ) : (
              <AgentTaskRow
                key={`agent:${entry.task.agentId}`}
                snapshot={entry.task}
                activity={activity[entry.task.agentId]}
                now={now}
                onCancel={() => {
                  void cancelSubagent(entry.task.agentId).catch(() => {})
                }}
                onClose={() => {
                  void closeSubagent(entry.task.agentId).catch(() => {})
                }}
              />
            )
          )}
        </div>
      </div>
    </div>
  )
}
