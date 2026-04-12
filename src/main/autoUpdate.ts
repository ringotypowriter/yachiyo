import { BrowserWindow, ipcMain, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'

import { resolveYachiyoSettingsPath } from './yachiyo-server/config/paths'
import { createSettingsStore } from './yachiyo-server/settings/settingsStore'
import type { UpdateChannel } from '../shared/yachiyo/protocol'

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  error?: string
}

let currentStatus: UpdateStatus = { state: 'idle' }

function broadcast(status: UpdateStatus): void {
  currentStatus = status
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('app-update:status', status)
  }
}

function readInitialChannel(): UpdateChannel {
  try {
    const store = createSettingsStore(resolveYachiyoSettingsPath())
    const config = store.read()
    return config.general?.updateChannel ?? 'stable'
  } catch {
    return 'stable'
  }
}

function setupDevMock(): void {
  ipcMain.handle('app-update:get-status', (): UpdateStatus => currentStatus)

  ipcMain.on('app-update:check', () => {
    broadcast({ state: 'checking' })
    setTimeout(() => broadcast({ state: 'available', version: '99.0.0' }), 1000)
  })

  ipcMain.on('app-update:download', () => {
    const steps = [0, 15, 35, 55, 75, 90, 100]
    steps.forEach((p, i) => {
      setTimeout(() => broadcast({ state: 'downloading', version: '99.0.0', percent: p }), i * 400)
    })
    setTimeout(() => broadcast({ state: 'ready', version: '99.0.0' }), steps.length * 400)
  })

  ipcMain.on('app-update:install', () => {
    console.log('[auto-update:dev] install requested — would quit and install in production')
  })

  ipcMain.on('app-update:open-release', () => {
    shell.openExternal('https://github.com/ringotypowriter/yachiyo/releases/latest')
  })

  ipcMain.on('app-update:set-channel', () => {
    // No-op in dev mode
  })

  // Simulate finding an update on launch
  setTimeout(() => broadcast({ state: 'checking' }), 2000)
  setTimeout(() => broadcast({ state: 'available', version: '99.0.0' }), 3000)
}

/** Extract a short, user-friendly message from electron-updater errors. */
function summarizeUpdateError(err: Error): string {
  const msg = err.message ?? String(err)

  // HttpError from electron-builder — grab just the first line (status + url)
  const httpMatch = msg.match(/HttpError:\s*(\d{3})\b/)
  if (httpMatch) {
    const code = httpMatch[1]
    if (code === '404') return 'Update not found — release may not be published yet.'
    return `Update server returned HTTP ${code}.`
  }

  // Network-level errors
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg)) {
    return 'Could not reach the update server. Check your network connection.'
  }

  // Fallback: first meaningful line, capped
  const firstLine = msg.split('\n')[0].trim()
  return firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine
}

function setupProd(): void {
  const channel = readInitialChannel()
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = channel === 'beta'

  autoUpdater.on('checking-for-update', () => {
    broadcast({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    broadcast({ state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    broadcast({ state: 'idle' })
  })

  autoUpdater.on('download-progress', (progress) => {
    broadcast({
      state: 'downloading',
      version: currentStatus.version,
      percent: Math.round(progress.percent)
    })
  })

  autoUpdater.on('update-downloaded', (info) => {
    broadcast({ state: 'ready', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    broadcast({ state: 'error', error: summarizeUpdateError(err) })
  })

  ipcMain.handle('app-update:get-status', (): UpdateStatus => currentStatus)

  ipcMain.on('app-update:check', () => {
    autoUpdater.checkForUpdates()
  })

  ipcMain.on('app-update:download', () => {
    autoUpdater.downloadUpdate()
  })

  ipcMain.on('app-update:install', () => {
    autoUpdater.quitAndInstall()
  })

  ipcMain.on('app-update:open-release', () => {
    const version = currentStatus.version
    const url = version
      ? `https://github.com/ringotypowriter/yachiyo/releases/tag/v${version}`
      : 'https://github.com/ringotypowriter/yachiyo/releases/latest'
    shell.openExternal(url)
  })

  ipcMain.on('app-update:set-channel', (_event, channel: UpdateChannel) => {
    const allowPre = channel === 'beta'
    if (autoUpdater.allowPrerelease !== allowPre) {
      autoUpdater.allowPrerelease = allowPre
      broadcast({ state: 'idle' })
      autoUpdater.checkForUpdates()
    }
  })

  // Check on launch, then every 4 hours
  autoUpdater.checkForUpdates()
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000)
}

export function setupAutoUpdate(): void {
  if (is.dev) {
    setupDevMock()
  } else {
    setupProd()
  }
}
