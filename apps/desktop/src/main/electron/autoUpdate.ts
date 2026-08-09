import { app, BrowserWindow, ipcMain, net, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import log from 'electron-log'

import { resolveYachiyoSettingsPath } from '@yachiyo/runtime/config/paths'
import { createSettingsStore } from '@yachiyo/runtime/settings/settingsStore'
import type { UpdateChannel } from '@yachiyo/shared/protocol'
import type { AppUpdateController } from './appUpdateController.ts'
import { createAppUpdateController } from './appUpdateController.ts'

import { createElectronProviderCredentialVault } from '../security/providerCredentials.ts'
import { UPDATE_MIRROR_BASE, resolveUpdateFeed } from './updateFeed'

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  error?: string
}

let currentStatus: UpdateStatus = { state: 'idle' }

let installing = false

/** True once the user triggers quit-and-install. Float window close guards
 *  should check this so they don't block the quit sequence. */
export function isInstallingUpdate(): boolean {
  return installing
}

function sendStatus(status: UpdateStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('app-update:status', status)
  }
}

function broadcast(status: UpdateStatus): void {
  currentStatus = status
  sendStatus(status)
}

function readInitialChannel(): UpdateChannel {
  try {
    const settingsPath = resolveYachiyoSettingsPath()
    const store = createSettingsStore(settingsPath, {
      providerCredentialVault: createElectronProviderCredentialVault(settingsPath)
    })
    const config = store.read()
    return config.general?.updateChannel ?? 'stable'
  } catch {
    return 'stable'
  }
}

const releaseNotesCache = new Map<string, string>()

async function fetchReleaseNotes(version: string): Promise<string> {
  const tag = version.startsWith('v') ? version : `v${version}`

  const cached = releaseNotesCache.get(tag)
  if (cached !== undefined) return cached

  const url = `https://api.github.com/repos/ringotypowriter/yachiyo/releases/tags/${tag}`
  const resp = await net.fetch(url, {
    headers: { Accept: 'application/vnd.github+json' }
  })
  if (!resp.ok) {
    throw new Error(`GitHub API returned ${resp.status}`)
  }
  const data = (await resp.json()) as { body?: string }
  const body = data.body ?? ''
  releaseNotesCache.set(tag, body)
  return body
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function setupDevMock(): AppUpdateController {
  const targetVersion = '99.0.0'
  const controller = createAppUpdateController({
    getRunningVersion: () => app.getVersion(),
    getDownloadedVersion: () =>
      currentStatus.state === 'ready' ? currentStatus.version : undefined,
    checkForUpdates: async () => {
      broadcast({ state: 'checking' })
      await wait(1_000)
      broadcast({ state: 'available', version: targetVersion })
      return { available: true, version: targetVersion }
    },
    downloadUpdate: async () => {
      const steps = [0, 15, 35, 55, 75, 90, 100]
      for (const percent of steps) {
        broadcast({ state: 'downloading', version: targetVersion, percent })
        await wait(400)
      }
      broadcast({ state: 'ready', version: targetVersion })
    },
    quitAndInstall: () => {
      console.log('[auto-update:dev] install requested — exercising quit flow')
      installing = true
      setImmediate(() => app.quit())
    }
  })

  ipcMain.handle('app-update:get-status', (): UpdateStatus => currentStatus)
  ipcMain.handle('app-update:get-release-notes', (_event, version: string) =>
    fetchReleaseNotes(version)
  )

  ipcMain.on('app-update:check', () => {
    void controller.status()
  })

  ipcMain.on('app-update:download', () => {
    void controller.prepareApply()
  })

  ipcMain.on('app-update:install', () => {
    controller.installPrepared()
  })

  ipcMain.on('app-update:open-release', () => {
    shell.openExternal('https://github.com/ringotypowriter/yachiyo/releases/latest')
  })

  ipcMain.on('app-update:set-channel', () => {
    // No-op in dev mode
  })

  // Simulate finding an update on launch
  setTimeout(() => broadcast({ state: 'checking' }), 2000)
  setTimeout(() => broadcast({ state: 'available', version: targetVersion }), 3000)

  return controller
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

function setupProd(): AppUpdateController {
  let channel = readInitialChannel()
  autoUpdater.logger = log
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = channel === 'beta'

  async function checkForUpdates(): Promise<{ available: boolean; version: string }> {
    const feed = await resolveUpdateFeed({
      mirrorBase: UPDATE_MIRROR_BASE,
      channel,
      platform: process.platform,
      fetchFn: (url, init) => net.fetch(url, init)
    })
    if (feed.source === 'mirror') {
      autoUpdater.setFeedURL({ provider: 'generic', url: feed.url })
    } else {
      autoUpdater.setFeedURL({ provider: 'github', owner: 'ringotypowriter', repo: 'yachiyo' })
    }
    autoUpdater.allowPrerelease = channel === 'beta'
    const result = await autoUpdater.checkForUpdates()
    if (!result) {
      throw new Error('The updater is unavailable in this build.')
    }
    return { available: result.isUpdateAvailable, version: result.updateInfo.version }
  }

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

  const installPreparedUpdate = (): void => {
    installing = true
    autoUpdater.quitAndInstall()
  }
  const controller = createAppUpdateController({
    getRunningVersion: () => app.getVersion(),
    getDownloadedVersion: () =>
      currentStatus.state === 'ready' ? currentStatus.version : undefined,
    checkForUpdates,
    downloadUpdate: async () => {
      await autoUpdater.downloadUpdate()
    },
    quitAndInstall: installPreparedUpdate
  })

  const broadcastFailure = (error: unknown): void => {
    const updateError = error instanceof Error ? error : new Error(String(error))
    broadcast({ state: 'error', error: summarizeUpdateError(updateError) })
  }

  const rejectExplicitActionDuringInstall = (): boolean => {
    if (!controller.hasActiveInstallReservation()) return false
    sendStatus({ state: 'error', error: 'Update installation is already in progress.' })
    return true
  }

  const checkForUpdatesInBackground = (): void => {
    const operation = controller.tryRunUpdaterOperation(checkForUpdates)
    if (!operation) {
      log.debug('[auto-update] skipped background check while installation is starting')
      return
    }
    void operation.catch(broadcastFailure)
  }

  ipcMain.handle('app-update:get-status', (): UpdateStatus => currentStatus)
  ipcMain.handle('app-update:get-release-notes', (_event, version: string) =>
    fetchReleaseNotes(version)
  )

  ipcMain.on('app-update:check', () => {
    if (rejectExplicitActionDuringInstall()) return
    void controller.status().catch(broadcastFailure)
  })

  ipcMain.on('app-update:download', () => {
    if (rejectExplicitActionDuringInstall()) return
    void controller
      .runUpdaterOperation(async () => {
        await autoUpdater.downloadUpdate()
      })
      .catch(broadcastFailure)
  })

  ipcMain.on('app-update:install', () => {
    if (rejectExplicitActionDuringInstall()) return
    void controller
      .runUpdaterOperation(
        () =>
          new Promise<void>((_resolve, reject) => {
            installing = true
            setImmediate(() => {
              try {
                autoUpdater.quitAndInstall()
              } catch (error) {
                reject(error)
              }
            })
          })
      )
      .catch(broadcastFailure)
  })

  ipcMain.on('app-update:open-release', () => {
    const version = currentStatus.version
    const url = version
      ? `https://github.com/ringotypowriter/yachiyo/releases/tag/v${version}`
      : 'https://github.com/ringotypowriter/yachiyo/releases/latest'
    shell.openExternal(url)
  })

  ipcMain.on('app-update:set-channel', (_event, nextChannel: UpdateChannel) => {
    if (nextChannel === channel) return
    if (rejectExplicitActionDuringInstall()) return
    void controller
      .runUpdaterOperation(async () => {
        channel = nextChannel
        broadcast({ state: 'idle' })
        await checkForUpdates()
      })
      .catch(broadcastFailure)
  })

  // Check on launch, then every 4 hours
  checkForUpdatesInBackground()
  setInterval(checkForUpdatesInBackground, 4 * 60 * 60 * 1000)

  return controller
}

export function setupAutoUpdate(): AppUpdateController {
  if (is.dev) {
    return setupDevMock()
  }
  return setupProd()
}
