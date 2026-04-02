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
    broadcast({ state: 'error', error: err.message })
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
