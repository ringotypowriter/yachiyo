import { BrowserWindow, ipcMain, Notification } from 'electron'

import type {
  NotificationThreadTarget,
  ShowNotificationInput,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import { getPerfMonitor } from '@yachiyo/runtime/services/perfMonitor'
import { isAuxiliaryWindow, isHighFrequencyChatEvent } from './filter.ts'
import { IPC_CHANNELS } from './ipcChannels.ts'

function focusNotificationWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
}

function navigateToNotificationThread(threadId: string, target: NotificationThreadTarget): void {
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
  const mainWindows = windows.filter((window) => !isAuxiliaryWindow(window))
  const targets = mainWindows.length > 0 ? mainWindows : windows
  const channel = target === 'archivedThread' ? 'navigate-to-archived-thread' : 'navigate-to-thread'

  for (const window of targets) {
    window.webContents.send(channel, threadId)
    focusNotificationWindow(window)
  }
}

export function showYachiyoNotification(input: ShowNotificationInput): void {
  if (!Notification.isSupported()) return

  const notification = new Notification({ title: input.title, body: input.body ?? '' })
  const threadId = input.threadId
  if (threadId) {
    notification.on('click', () => {
      navigateToNotificationThread(threadId, input.target ?? 'thread')
    })
  }
  notification.show()
}

export function broadcastYachiyoEvent(event: YachiyoServerEvent): void {
  getPerfMonitor().recordIpcEvent(event.type)

  if (event.type === 'notification.requested') {
    const anyFocused = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())
    if (!anyFocused) {
      showYachiyoNotification({
        title: event.title,
        body: event.body,
        threadId: event.threadId,
        target: 'thread'
      })
    }
  }

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    if (isHighFrequencyChatEvent(event) && isAuxiliaryWindow(window)) {
      continue
    }
    window.webContents.send(IPC_CHANNELS.event, event)
  }
}

export function handleYachiyoIpc<Args extends unknown[], Result>(
  channel: string,
  listener: (...args: Args) => Result | Promise<Result>
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (_event, ...args: Args) => listener(...args))
}
