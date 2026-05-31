import { app, BrowserWindow, ipcMain, Notification } from 'electron'

import type {
  NotificationThreadTarget,
  ShowNotificationInput,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import { getPerfMonitor } from '@yachiyo/runtime/services/perfMonitor'
import { isAuxiliaryWindow, isHighFrequencyChatEvent } from './filter.ts'
import { IPC_CHANNELS } from './ipcChannels.ts'
import { createDockBadgeController } from './dockBadgeController.ts'

const notificationDockBadge = createDockBadgeController({
  platform: process.platform,
  setBadgeCount: (count) => app.setBadgeCount(count)
})

function hasFocusedYachiyoWindow(): boolean {
  return BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFocused())
}

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

export function clearYachiyoNotificationBadge(): void {
  notificationDockBadge.clear()
}

export function showYachiyoNotification(input: ShowNotificationInput): void {
  if (!Notification.isSupported()) return

  const shouldShowDockBadge = !hasFocusedYachiyoWindow()
  const notification = new Notification({ title: input.title, body: input.body ?? '' })
  const threadId = input.threadId
  notification.on('click', () => {
    clearYachiyoNotificationBadge()
    if (threadId) {
      navigateToNotificationThread(threadId, input.target ?? 'thread')
    }
  })
  notification.show()
  if (shouldShowDockBadge) notificationDockBadge.increment()
}

export function broadcastYachiyoEvent(event: YachiyoServerEvent): void {
  getPerfMonitor().recordIpcEvent(event.type)

  if (event.type === 'notification.requested') {
    if (!hasFocusedYachiyoWindow()) {
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
