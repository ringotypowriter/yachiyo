import { BrowserWindow, ipcMain, Notification } from 'electron'

import type { YachiyoServerEvent } from '../../shared/yachiyo/protocol'
import { getPerfMonitor } from '../yachiyo-server/services/perfMonitor.ts'
import { isAuxiliaryWindow, isHighFrequencyChatEvent } from './filter.ts'
import { IPC_CHANNELS } from './ipcChannels.ts'

export function broadcastYachiyoEvent(event: YachiyoServerEvent): void {
  getPerfMonitor().recordIpcEvent(event.type)

  if (event.type === 'notification.requested') {
    const anyFocused = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isFocused())
    if (!anyFocused && Notification.isSupported()) {
      new Notification({ title: event.title, body: event.body }).show()
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
