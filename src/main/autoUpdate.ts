import { app, BrowserWindow, ipcMain } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  error?: string
}

let currentStatus: UpdateStatus = { state: 'idle' }

function broadcast(status: UpdateStatus): void {
  currentStatus = status
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('app-update:status', status)
  }
}

function setupDevMock(): void {
  ipcMain.handle('app-update:get-status', (): UpdateStatus => currentStatus)

  ipcMain.on('app-update:install', () => {
    console.log('[auto-update:dev] install requested — would quit and install in production')
  })

  ipcMain.on('app-update:check', () => {
    console.log('[auto-update:dev] check requested — simulating update available')
    broadcast({ state: 'checking' })
    setTimeout(() => broadcast({ state: 'available', version: '99.0.0' }), 1000)
  })

  ipcMain.on('app-update:download', () => {
    console.log('[auto-update:dev] download requested — simulating download')
    broadcast({ state: 'downloading', version: '99.0.0' })
    setTimeout(() => broadcast({ state: 'ready', version: '99.0.0' }), 3000)
  })

  // Simulate finding an update on launch
  setTimeout(() => broadcast({ state: 'checking' }), 2000)
  setTimeout(() => broadcast({ state: 'available', version: '99.0.0' }), 3000)
}

function setupProd(): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    broadcast({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    broadcast({ state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    broadcast({ state: 'idle' })
  })

  autoUpdater.on('download-progress', () => {
    if (currentStatus.state !== 'downloading') {
      broadcast({ state: 'downloading', version: currentStatus.version })
    }
  })

  autoUpdater.on('update-downloaded', (info) => {
    broadcast({ state: 'ready', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    broadcast({ state: 'error', error: err.message })
  })

  ipcMain.handle('app-update:get-status', (): UpdateStatus => currentStatus)

  ipcMain.on('app-update:download', () => {
    autoUpdater.downloadUpdate()
  })

  ipcMain.on('app-update:install', () => {
    autoUpdater.autoInstallOnAppQuit = true
    app.relaunch()
    app.exit(0)
  })

  ipcMain.on('app-update:check', () => {
    autoUpdater.checkForUpdates()
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
