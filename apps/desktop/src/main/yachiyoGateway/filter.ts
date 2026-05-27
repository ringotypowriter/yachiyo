import type { BrowserWindow } from 'electron'
import type { YachiyoServerEvent } from '@yachiyo/shared/protocol'

export function isHighFrequencyChatEvent(event: YachiyoServerEvent): boolean {
  return event.type === 'message.delta' || event.type === 'message.reasoning.delta'
}

export function isAuxiliaryWindow(window: BrowserWindow): boolean {
  const url = window.webContents.getURL()
  return url.includes('/translator/') || url.includes('/jotdown/')
}
