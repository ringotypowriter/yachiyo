import { create } from 'zustand'

import type {
  BackgroundTaskCompletedEvent,
  BackgroundTaskLogAppendEvent,
  BackgroundTaskSnapshot,
  BackgroundTaskSnapshotStatus,
  BackgroundTaskStartedEvent
} from '../../../../../shared/yachiyo/protocol.ts'

const MAX_LOG_LINES = 500
const MAX_RECENT_COMPLETED_PER_THREAD = 20

export interface BackgroundTaskState {
  taskId: string
  threadId: string
  command: string
  startedAt: string
  status: BackgroundTaskSnapshotStatus
  exitCode?: number
  finishedAt?: string
  cancelledByUser?: boolean
  logTail: string[]
}

interface BackgroundTasksState {
  // threadId -> taskId -> task
  tasksByThread: Record<string, Record<string, BackgroundTaskState>>

  hydrate: (threadId: string, snapshots: BackgroundTaskSnapshot[]) => void
  onStarted: (event: BackgroundTaskStartedEvent) => void
  onLogAppend: (event: BackgroundTaskLogAppendEvent) => void
  onCompleted: (event: BackgroundTaskCompletedEvent) => void
  dismissTask: (threadId: string, taskId: string) => void
  dismissAllFinished: (threadId: string) => void
  clearThread: (threadId: string) => void
}

function appendLogLines(existing: string[], lines: string[]): string[] {
  if (lines.length === 0) return existing
  const next = existing.concat(lines)
  if (next.length <= MAX_LOG_LINES) return next
  return next.slice(next.length - MAX_LOG_LINES)
}

export const useBackgroundTasksStore = create<BackgroundTasksState>((set) => ({
  tasksByThread: {},

  hydrate: (threadId, snapshots) =>
    set((state) => {
      const existing = state.tasksByThread[threadId] ?? {}
      const next: Record<string, BackgroundTaskState> = {}
      for (const snap of snapshots) {
        const prior = existing[snap.taskId]
        // Prefer the live tail we already have (it's the freshest); fall back to
        // the server-supplied historical tail read from logPath; otherwise empty.
        const logTail =
          prior && prior.logTail.length > 0 ? prior.logTail : (snap.recentLogTail ?? [])
        next[snap.taskId] = {
          taskId: snap.taskId,
          threadId: snap.threadId,
          command: snap.command,
          startedAt: snap.startedAt,
          status: snap.status,
          ...(snap.exitCode != null ? { exitCode: snap.exitCode } : {}),
          ...(snap.finishedAt ? { finishedAt: snap.finishedAt } : {}),
          ...(snap.cancelledByUser ? { cancelledByUser: true } : {}),
          logTail
        }
      }
      for (const [taskId, prior] of Object.entries(existing)) {
        if (next[taskId]) continue
        if (prior.status === 'running') continue
        next[taskId] = prior
      }
      return { tasksByThread: { ...state.tasksByThread, [threadId]: next } }
    }),

  onStarted: (event) =>
    set((state) => {
      const threadTasks = state.tasksByThread[event.threadId] ?? {}
      if (threadTasks[event.taskId]) return state
      const task: BackgroundTaskState = {
        taskId: event.taskId,
        threadId: event.threadId,
        command: event.command,
        startedAt: event.startedAt,
        status: 'running',
        logTail: []
      }
      return {
        tasksByThread: {
          ...state.tasksByThread,
          [event.threadId]: { ...threadTasks, [event.taskId]: task }
        }
      }
    }),

  onLogAppend: (event) =>
    set((state) => {
      const threadTasks = state.tasksByThread[event.threadId]
      if (!threadTasks) return state
      const task = threadTasks[event.taskId]
      if (!task) return state
      const updated: BackgroundTaskState = {
        ...task,
        logTail: appendLogLines(task.logTail, event.lines)
      }
      return {
        tasksByThread: {
          ...state.tasksByThread,
          [event.threadId]: { ...threadTasks, [event.taskId]: updated }
        }
      }
    }),

  onCompleted: (event) =>
    set((state) => {
      const threadTasks = state.tasksByThread[event.threadId] ?? {}
      const prior = threadTasks[event.taskId]
      const cancelled = event.cancelledByUser === true
      const updated: BackgroundTaskState = {
        taskId: event.taskId,
        threadId: event.threadId,
        command: event.command,
        startedAt: prior?.startedAt ?? new Date().toISOString(),
        status: event.exitCode === 0 ? 'completed' : 'failed',
        exitCode: event.exitCode,
        finishedAt: new Date().toISOString(),
        ...(cancelled ? { cancelledByUser: true } : {}),
        logTail: prior?.logTail ?? []
      }
      // Cap the number of completed entries we keep around per thread, evicting
      // the oldest finished tasks first so the panel doesn't grow forever.
      const merged: Record<string, BackgroundTaskState> = {
        ...threadTasks,
        [event.taskId]: updated
      }
      const completed = Object.values(merged).filter((t) => t.status !== 'running')
      if (completed.length > MAX_RECENT_COMPLETED_PER_THREAD) {
        const sorted = completed.sort((a, b) =>
          (a.finishedAt ?? '').localeCompare(b.finishedAt ?? '')
        )
        const toEvict = sorted.slice(0, completed.length - MAX_RECENT_COMPLETED_PER_THREAD)
        for (const t of toEvict) delete merged[t.taskId]
      }
      return {
        tasksByThread: {
          ...state.tasksByThread,
          [event.threadId]: merged
        }
      }
    }),

  dismissTask: (threadId, taskId) =>
    set((state) => {
      const threadTasks = state.tasksByThread[threadId]
      if (!threadTasks || !threadTasks[taskId]) return state
      // Only allow dismissing finished tasks; running ones must complete first.
      if (threadTasks[taskId].status === 'running') return state
      const next = { ...threadTasks }
      delete next[taskId]
      return { tasksByThread: { ...state.tasksByThread, [threadId]: next } }
    }),

  dismissAllFinished: (threadId) =>
    set((state) => {
      const threadTasks = state.tasksByThread[threadId]
      if (!threadTasks) return state
      const next: Record<string, BackgroundTaskState> = {}
      for (const [id, task] of Object.entries(threadTasks)) {
        if (task.status === 'running') next[id] = task
      }
      return { tasksByThread: { ...state.tasksByThread, [threadId]: next } }
    }),

  clearThread: (threadId) =>
    set((state) => {
      if (!state.tasksByThread[threadId]) return state
      const next = { ...state.tasksByThread }
      delete next[threadId]
      return { tasksByThread: next }
    })
}))

export function selectThreadTasks(threadId: string | null | undefined) {
  return (state: BackgroundTasksState): BackgroundTaskState[] => {
    if (!threadId) return []
    const map = state.tasksByThread[threadId]
    if (!map) return []
    return Object.values(map).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }
}

export function selectThreadRunningCount(threadId: string | null | undefined) {
  return (state: BackgroundTasksState): number => {
    if (!threadId) return 0
    const map = state.tasksByThread[threadId]
    if (!map) return 0
    let count = 0
    for (const t of Object.values(map)) {
      if (t.status === 'running') count++
    }
    return count
  }
}
