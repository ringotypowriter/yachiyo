import type {
  BackgroundTaskLogSnapshot,
  BackgroundTaskSnapshot,
  ToolCallRecord
} from '../../../../shared/yachiyo/protocol.ts'
import { readBackgroundTaskLogTail } from '../domain/background/backgroundTaskLog.ts'

export interface BackgroundTaskLogTarget {
  taskId: string
  threadId: string
  command: string
  logPath: string
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error != null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

export async function hydrateBackgroundTaskSnapshots(
  snapshots: BackgroundTaskSnapshot[]
): Promise<BackgroundTaskSnapshot[]> {
  const tailLines = 200
  return Promise.all(
    snapshots.map(async (snap) => {
      try {
        const tail = await readBackgroundTaskLogTail(snap.logPath)
        const lines = tail.content.split('\n')
        if (tail.truncated && lines.length > 1) lines.shift()
        if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
        return { ...snap, recentLogTail: lines.slice(-tailLines) }
      } catch (error) {
        if (isFileNotFoundError(error)) {
          return snap
        }
        throw error
      }
    })
  )
}

export async function readBackgroundTaskLogSnapshot(
  target: BackgroundTaskLogTarget,
  maxBytes: number | undefined
): Promise<BackgroundTaskLogSnapshot> {
  try {
    const tail = await readBackgroundTaskLogTail(target.logPath, maxBytes)
    return {
      taskId: target.taskId,
      threadId: target.threadId,
      command: target.command,
      logPath: target.logPath,
      content: tail.content,
      truncated: tail.truncated,
      totalBytes: tail.totalBytes,
      startByte: tail.startByte
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) {
      throw error
    }
  }

  return {
    taskId: target.taskId,
    threadId: target.threadId,
    command: target.command,
    logPath: target.logPath,
    content: '',
    truncated: false,
    totalBytes: 0,
    startByte: 0
  }
}

export function getBackgroundTaskLogTargetFromToolCalls(
  toolCalls: ToolCallRecord[],
  input: { threadId: string; taskId: string }
): BackgroundTaskLogTarget | undefined {
  const toolCall = toolCalls.find((tc) => tc.id === input.taskId)
  if (!toolCall || toolCall.details == null || typeof toolCall.details !== 'object') {
    return undefined
  }

  const details = toolCall.details as unknown as Record<string, unknown>
  if (typeof details.command !== 'string' || typeof details.logPath !== 'string') {
    return undefined
  }

  return {
    taskId: input.taskId,
    threadId: input.threadId,
    command: details.command,
    logPath: details.logPath
  }
}
