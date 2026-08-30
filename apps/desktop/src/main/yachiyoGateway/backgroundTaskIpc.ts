import type { BackgroundTaskLogSnapshot, BackgroundTaskSnapshot } from '@yachiyo/shared/protocol'

import { handleYachiyoIpc } from './ipc.ts'
import { IPC_CHANNELS } from './ipcChannels.ts'
import { createShutdownReadBarrier } from './shutdownReadBarrier.ts'

interface BackgroundTaskRpc {
  listBackgroundTasks(input?: { threadId?: string }): Promise<BackgroundTaskSnapshot[]>
  getBackgroundTaskLog(input: {
    threadId: string
    taskId: string
    maxBytes?: number
  }): Promise<BackgroundTaskLogSnapshot>
  cancelBackgroundTask(input: { taskId: string }): Promise<boolean>
}

function emptyLogSnapshot(input: { threadId: string; taskId: string }): BackgroundTaskLogSnapshot {
  return {
    taskId: input.taskId,
    threadId: input.threadId,
    command: '',
    logPath: '',
    content: '',
    truncated: false,
    totalBytes: 0,
    startByte: 0
  }
}

export function registerBackgroundTaskIpc(getRpc: () => BackgroundTaskRpc): {
  beginShutdown(): Promise<void>
} {
  const reads = createShutdownReadBarrier()

  handleYachiyoIpc(IPC_CHANNELS.listBackgroundTasks, (input?: { threadId?: string }) =>
    reads.run(
      () => getRpc().listBackgroundTasks(input),
      () => []
    )
  )
  handleYachiyoIpc(
    IPC_CHANNELS.getBackgroundTaskLog,
    (input: { threadId: string; taskId: string; maxBytes?: number }) =>
      reads.run(
        () => getRpc().getBackgroundTaskLog(input),
        () => emptyLogSnapshot(input)
      )
  )
  handleYachiyoIpc(IPC_CHANNELS.cancelBackgroundTask, (input: { taskId: string }) =>
    getRpc().cancelBackgroundTask(input)
  )

  return { beginShutdown: () => reads.beginShutdown() }
}
