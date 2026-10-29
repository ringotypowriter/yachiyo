import { is } from '@electron-toolkit/utils'
import { t } from '@yachiyo/i18n/index'
import { getActivityTracker } from '@yachiyo/runtime/activity/ActivityTracker'
import { createActivityTrackerRpcTarget } from '@yachiyo/runtime/activity/activityTrackerRpcBridge'
import { resolveActivityTrackingPermissionForSave } from '@yachiyo/runtime/activity/activityTrackingPermission'
import { probeFullActivityAccess } from '@yachiyo/runtime/activity/osascript'
import { type YachiyoServer } from '@yachiyo/runtime/app/host/YachiyoServer'
import type {
  AppUpdateCommandInput,
  AppUpdateCommandReply
} from '@yachiyo/runtime/appServer/commandSocket'
import {
  resolveYachiyoBrowserAutomationProfilePath,
  resolveYachiyoDataDir
} from '@yachiyo/runtime/config/paths'
import { createBrowserAutomationRpcTarget } from '@yachiyo/runtime/services/browserAutomation/browserAutomationRpcBridge'
import {
  createElectronBrowserAutomationService,
  type BrowserAutomationService
} from '@yachiyo/runtime/services/browserAutomation/electronBrowserAutomationService'
import { createWebExternalFetchRpcTarget } from '@yachiyo/runtime/services/webExternalFetchRpcBridge'
import { createBrowserSearchPageFactoryRpcTarget } from '@yachiyo/runtime/services/webSearch/browserSearchPageFactoryRpcBridge'
import { createElectronBrowserSearchPageFactory } from '@yachiyo/runtime/services/webSearch/electronBrowserSearchSession'
import type {
  BrowserAutomationSessionRecord,
  HideBrowserAutomationSessionInput,
  ListBrowserAutomationSessionsInput,
  SetBrowserAutomationSessionBoundsInput,
  SettingsConfig,
  ShowBrowserAutomationSessionInput,
  ShowNotificationInput,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import type { RpcMethods } from '@yachiyo/shared/rpc/rpcClient'
import { spawn } from 'child_process'
import {
  app,
  BrowserWindow,
  ipcMain,
  powerMonitor,
  powerSaveBlocker,
  session,
  systemPreferences
} from 'electron'
import { randomUUID } from 'node:crypto'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createGatewayPendingUpdateReceiptDelivery } from '../appUpdate/gatewayPendingUpdateReceiptDelivery.ts'
import { createGatewayRunAdmission } from '../appUpdate/gatewayRunAdmission.ts'
import type { OriginLookup } from '../appUpdate/installReceiptSequence.ts'
import {
  clearPendingUpdateReceipt,
  writePendingUpdateReceipt
} from '../appUpdate/pendingUpdateReceipt.ts'
import { createAppUpdateCommandHandler } from '../cli/appUpdateCommand.ts'
import { discoverApps, findDiscoveredApp, launchDiscoveredApp } from '../electron/appDiscovery.ts'
import type { AppUpdateController } from '../electron/appUpdateController.ts'
import { isInstallingUpdate } from '../electron/autoUpdate.ts'
import { deferAppQuitUntil } from '../electron/deferredAppQuit.ts'
import { openThreadWorkspace } from '../electron/openThreadWorkspace.ts'
import { readAppLogEntries } from '../logs/appLogFiles.ts'
import { createDesktopAppServer, type DesktopAppServer } from '../runtimeHost/desktopAppServer.ts'
import { registerBrowserPreviewHandlers } from './browserPreviewHandlers'
import { logBrowserSearchDiagnostic } from './browserSearchDiagnostics.ts'

import { registerGatewayFileHandlers } from './fileHandlers.ts'
import { broadcastYachiyoEvent, handleYachiyoIpc, showYachiyoNotification } from './ipc.ts'
import { IPC_CHANNELS } from './ipcChannels.ts'
import { registerPngExportHandlers } from './pngExportHandlers.ts'
import { normalizePngBytes, normalizePngFilename, type SavePngFileInput } from './pngFile.ts'
import { registerProviderBackupHandlers } from './providerBackupHandlers.ts'

import { createRemoteKeepAwake } from '@yachiyo/runtime/remote/keepAwake'
import { createRpcMethodProxy } from '@yachiyo/shared/rpc/rpcClient'

type NativeServer = Pick<
  YachiyoServer,
  | 'getConfig'
  | 'cancelActiveRuns'
  | 'listActiveRunIds'
  | 'openThreadWorkspace'
  | 'closeRunAdmissionAndGetActiveRunIds'
  | 'openRunAdmission'
>
export interface YachiyoGatewayHandle {
  getConfig(): Promise<SettingsConfig>
  subscribe(listener: (event: YachiyoServerEvent) => void): () => void
  cancelActiveRuns(): void
  listActiveRunIds(): string[]
  closeRunAdmissionAndGetActiveRunIds(ownerId: string): Promise<string[]>
  openRunAdmission(ownerId: string): Promise<void>
}
let serverRpc: DesktopAppServer | null = null
let gatewayHandle: YachiyoGatewayHandle | null = null
let browserAutomationService: BrowserAutomationService | null = null
const activeRunIds = new Set<string>()
let runtimeCrashed = false
let appUpdateController: AppUpdateController | null = null
let channelPokesRegistered = false

function rpc(): RpcMethods<NativeServer> {
  if (!serverRpc) throw new Error('App server connection is not initialized')
  return createRpcMethodProxy<NativeServer>(serverRpc.client)
}
function hostCall<TResult = unknown>(method: string, args: unknown[] = []): Promise<TResult> {
  if (!serverRpc) return Promise.reject(new Error('App server connection is not initialized'))
  return serverRpc.client.call(`host.${method}`, args) as Promise<TResult>
}
function browserAutomation(): BrowserAutomationService {
  if (!browserAutomationService) throw new Error('Native browser host is unavailable')
  return browserAutomationService
}
function broadcastRuntimeHealth(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed())
      window.webContents.send(IPC_CHANNELS.runtimeHealthStatus, { crashed: runtimeCrashed })
  }
}
const { closeRunAdmissionAndGetActiveRunIds, openRunAdmission } =
  createGatewayRunAdmission<DesktopAppServer>({
    closeRuntime: (ownerId) => rpc().closeRunAdmissionAndGetActiveRunIds(ownerId),
    getRuntime: () => serverRpc,
    openRuntime: async (ownerId, runtime) => {
      if (!runtime) throw new Error('App server is not connected')
      await runtime.client.call('openRunAdmission', [ownerId])
    },
    recoverRuntime: (runtime) => {
      if (runtime) void runtime.reconnect().catch(console.error)
    },
    onOpenError: (error) => console.error('[app-server] reopening admission failed:', error)
  })
const {
  updateReceiptCoordinator,
  receiptPath: pendingUpdateReceiptPath,
  requestDelivery: requestPendingUpdateReceiptDelivery
} = createGatewayPendingUpdateReceiptDelivery({
  userDataPath: () => app.getPath('userData'),
  currentVersion: () => app.getVersion(),
  useUtilityRuntime: true,
  hostCall,
  getLiveServices: () => null
})
async function handleAppUpdate(input: AppUpdateCommandInput): Promise<AppUpdateCommandReply> {
  if (!appUpdateController) {
    throw new Error('App updater is not running.')
  }
  return createAppUpdateCommandHandler({
    controller: appUpdateController,
    getRunningVersion: () => app.getVersion(),
    getActiveRunIds: () => gatewayHandle?.listActiveRunIds() ?? [],
    closeRunAdmissionAndGetActiveRunIds,
    openRunAdmission,
    receipt: {
      resolveOrigin: (runId) =>
        hostCall<
          | { kind: 'origin'; channelId: string; threadId: string; messageId: string }
          | { kind: 'no-channel' }
          | { kind: 'lookup-failed'; reason: string }
        >('resolveRunChannelOrigin', [runId]).then(
          (result): OriginLookup =>
            result.kind === 'origin'
              ? {
                  kind: 'origin',
                  origin: {
                    channelId: result.channelId,
                    threadId: result.threadId,
                    messageId: result.messageId
                  }
                }
              : result,
          // A lookup we could not perform is reported as exactly that.
          // Reporting it as "no channel" is what let an unreachable RPC
          // disguise itself as a local thread and skip the receipt in
          // silence.
          (error): OriginLookup => ({
            kind: 'lookup-failed',
            reason: error instanceof Error ? error.message : String(error)
          })
        ),
      persist: (record) => writePendingUpdateReceipt(pendingUpdateReceiptPath(), record),
      clear: (attemptId) => clearPendingUpdateReceipt(pendingUpdateReceiptPath(), attemptId),
      announce: async (origin, signal, notAfterMs) => {
        // If the bounded wait already elapsed, the caller has moved on;
        // sending now would promise a return for an install that may
        // never have started.
        if (signal.aborted) return
        await hostCall('sendChannelMessage', [
          { id: origin.channelId, message: '开始更新，稍后回来。', notAfterMs }
        ])
      },
      reportInstallFailure: async (origin) => {
        await hostCall('sendChannelMessage', [
          { id: origin.channelId, message: '更新未能启动，请稍后重试。' }
        ])
      },
      reportInstallFailureTimeoutMs: 2_000,
      announceTimeoutMs: 2_000,
      now: () => Date.now(),
      targetVersion: () => appUpdateController?.getPreparedVersion()
    }
  })(input)
}
function registerChannelHealthPokes(): void {
  if (channelPokesRegistered) return

  channelPokesRegistered = true
  // Periodic health checks run inside the runtime host; main only forwards
  // power events, which never reach the other process on their own.
  const poke = (reason: string, delayMs = 0): void => {
    setTimeout(() => {
      void hostCall('pokeChannels', [{ reason }]).catch((error) => {
        console.warn('[channel-poke] failed:', error)
      })
    }, delayMs)
  }

  powerMonitor.on('lock-screen', () => poke('lock-screen', 1_000))
  powerMonitor.on('unlock-screen', () => poke('unlock-screen'))
  powerMonitor.on('resume', () => poke('resume'))
  powerMonitor.on('user-did-become-active', () => poke('user-did-become-active'))
}

export function registerYachiyoGateway(options: {
  appUpdateController: AppUpdateController
  startupReady: Promise<void>
}): YachiyoGatewayHandle {
  if (gatewayHandle) return gatewayHandle
  appUpdateController = options.appUpdateController
  // A dedicated session for external web content (webRead direct-fetch path).
  // SSL-intercepting proxies re-sign certificates, so we relax verification
  // here only — provider API traffic stays on the default session with full TLS.
  const webExternalSession = session.fromPartition('persist:web-external', { cache: true })
  const webExternalProxyUrl = (
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy
  )?.trim()
  void webExternalSession.setProxy(
    webExternalProxyUrl
      ? { mode: 'fixed_servers' as const, proxyRules: webExternalProxyUrl }
      : { mode: 'system' as const }
  )
  webExternalSession.setCertificateVerifyProc((_request, callback) => callback(0))
  const webExternalFetchImpl: typeof fetch = (input, init?) =>
    webExternalSession.fetch(
      input instanceof URL ? input.toString() : (input as string | Request),
      init
    )

  browserAutomationService = createElectronBrowserAutomationService({
    profilePath: resolveYachiyoBrowserAutomationProfilePath()
  })
  const pendingReplies = new Map<
    string,
    { reply: AppUpdateCommandReply; timer: ReturnType<typeof setTimeout> }
  >()
  const remoteKeepAwake = createRemoteKeepAwake({
    startBlocker: () => powerSaveBlocker.start('prevent-app-suspension'),
    stopBlocker: (id) => powerSaveBlocker.stop(id),
    isOnBattery: () => powerMonitor.isOnBatteryPower(),
    onPowerSourceChange: (listener) => {
      powerMonitor.on('on-ac', listener)
      powerMonitor.on('on-battery', listener)
      return () => {
        powerMonitor.off('on-ac', listener)
        powerMonitor.off('on-battery', listener)
      }
    }
  })
  serverRpc = createDesktopAppServer({
    entryPath: join(__dirname, 'app-server.js'),
    isDev: is.dev,
    startupReady: options.startupReady,
    mainServicesTarget: {
      ...createBrowserAutomationRpcTarget(browserAutomationService),
      ...createBrowserSearchPageFactoryRpcTarget(
        createElectronBrowserSearchPageFactory({ log: logBrowserSearchDiagnostic })
      ),
      ...createActivityTrackerRpcTarget({
        finalizeAndConsume: () => getActivityTracker('simple').finalizeAndConsume()
      }),
      ...createWebExternalFetchRpcTarget(webExternalFetchImpl),
      'mainHost.showNotification': (input: ShowNotificationInput) => {
        showYachiyoNotification(input)
      },
      // The runtime carries an undeliverable receipt on its next real
      // outbound. It gets a lease and a finished sentence — never the record
      // itself, so there is only ever one writer.
      'mainHost.claimUpdateReceipt': (input: { channelId: string }) =>
        updateReceiptCoordinator.claim(input.channelId),
      'mainHost.ackUpdateReceipt': (input: { claimToken: string }) => {
        updateReceiptCoordinator.ack(input.claimToken)
      },
      'mainHost.releaseUpdateReceipt': (input: { claimToken: string }) => {
        updateReceiptCoordinator.release(input.claimToken)
      },
      'mainHost.prepareAppUpdate': async (input: AppUpdateCommandInput) => {
        const reply = await handleAppUpdate(input)
        const id = randomUUID()
        const timer = setTimeout(() => {
          pendingReplies.delete(id)
          void reply.onReplyFailure?.()
        }, 30_000)
        pendingReplies.set(id, { reply, timer })
        return { id, result: reply.result }
      },
      'mainHost.finishAppUpdate': (id: string, delivered: boolean) => {
        const pending = pendingReplies.get(id)
        if (!pending) throw new Error('App update response expired')
        pendingReplies.delete(id)
        clearTimeout(pending.timer)
        // Send the RPC acknowledgement before an installer closes this shell.
        setTimeout(() => {
          void Promise.resolve(
            delivered ? pending.reply.afterReply?.() : pending.reply.onReplyFailure?.()
          ).catch(console.error)
        }, 0)
      },
      'mainHost.prepareConfig': async (input: SettingsConfig, current: SettingsConfig) =>
        resolveActivityTrackingPermissionForSave(input, current, {
          platform: process.platform,
          requestAccessibilityTrust: () => systemPreferences.isTrustedAccessibilityClient(true),
          probeFullActivityAccess
        }),
      'mainHost.remoteKeepAwake': (wanted: boolean) => remoteKeepAwake.setWanted(wanted)
    },
    onConnectionChange: (connected) => {
      runtimeCrashed = !connected
      broadcastRuntimeHealth()
    },
    onConnected: () => {
      void rpc()
        .listActiveRunIds()
        .then((ids) => {
          activeRunIds.clear()
          for (const id of ids) activeRunIds.add(id)
        })
        .catch(console.error)
      void rpc()
        .getConfig()
        .then((config) =>
          remoteKeepAwake.setWanted(
            config.remote?.enabled === true && config.remote.keepAwakeOnPower
          )
        )
        .catch(console.error)
      void requestPendingUpdateReceiptDelivery()
    }
  })
  serverRpc.client.subscribe((payload) => {
    const event = payload as YachiyoServerEvent
    if (event.type === 'run.created') activeRunIds.add(event.runId)
    if (
      event.type === 'run.completed' ||
      event.type === 'run.failed' ||
      event.type === 'run.cancelled'
    )
      activeRunIds.delete(event.runId)
    if (event.type === 'settings.updated' && process.platform === 'darwin') {
      const tracking = event.config.general?.activityTracking
      if (tracking) {
        const tracker = getActivityTracker(tracking.mode)
        tracker.setMode(
          tracking.mode,
          tracking.mode === 'full'
            ? { fullModeAvailable: tracking.accessibilityDenied !== true }
            : undefined
        )
        tracker.setOcrConfig(tracking.ocr)
      }
    }
    broadcastYachiyoEvent(event)
  })
  gatewayHandle = {
    getConfig: () => rpc().getConfig(),
    subscribe: (listener) =>
      serverRpc!.client.subscribe((event) => listener(event as YachiyoServerEvent)),
    cancelActiveRuns: () => {
      void rpc().cancelActiveRuns().catch(console.error)
    },
    listActiveRunIds: () => [...activeRunIds],
    closeRunAdmissionAndGetActiveRunIds,
    openRunAdmission
  }
  ipcMain.handle('yachiyo:app-server-session', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || event.senderFrame !== event.sender.mainFrame)
      throw new Error('App server access requires a trusted app window')
    const url = new URL(event.senderFrame.url)
    const devOrigin =
      is.dev && process.env.ELECTRON_RENDERER_URL
        ? new URL(process.env.ELECTRON_RENDERER_URL).origin
        : undefined
    const packagedPage =
      url.protocol === 'file:'
        ? relative(resolve(__dirname, '../renderer'), fileURLToPath(url)).replaceAll('\\', '/')
        : undefined
    if (
      packagedPage
        ? !['index.html', 'translator/index.html', 'jotdown/index.html'].includes(packagedPage)
        : url.origin !== devOrigin
    ) {
      throw new Error('Untrusted app server client origin')
    }
    return serverRpc!.createClientSession(url.protocol === 'file:' ? 'file://' : url.origin)
  })
  void serverRpc.ready().catch((error) => {
    runtimeCrashed = true
    broadcastRuntimeHealth()
    console.error('[app-server] startup failed:', error)
  })
  ipcMain.removeAllListeners(IPC_CHANNELS.showNotification)
  ipcMain.on(IPC_CHANNELS.showNotification, (_event, input: ShowNotificationInput) => {
    showYachiyoNotification(input)
  })

  ipcMain.removeAllListeners(IPC_CHANNELS.beep)
  ipcMain.on(IPC_CHANNELS.beep, () => {
    if (process.platform === 'darwin') {
      spawn('afplay', ['-v', '0.4', '/System/Library/Sounds/Glass.aiff'], { detached: true })
    }
  })

  registerChannelHealthPokes()

  handleYachiyoIpc(IPC_CHANNELS.showEmojiPanel, () => {
    app.showEmojiPanel()
  })
  handleYachiyoIpc(IPC_CHANNELS.openThreadWorkspace, (input: { threadId: string }) =>
    rpc()
      .openThreadWorkspace(input)
      .then((workspacePath) => openThreadWorkspace(input.threadId, workspacePath))
  )
  handleYachiyoIpc(IPC_CHANNELS.listDiscoveredApps, () => discoverApps())
  handleYachiyoIpc(
    IPC_CHANNELS.openWorkspaceWithApp,
    async (input: { threadId: string; appName: string }) => {
      const workspacePath = await rpc().openThreadWorkspace({ threadId: input.threadId })
      const selectedApp = findDiscoveredApp(await discoverApps(), input.appName, [
        'editor',
        'terminal'
      ])
      if (!selectedApp) throw new Error(`Application "${input.appName}" is not installed.`)
      await openThreadWorkspace(input.threadId, workspacePath, {
        openPath: async (path) => {
          await launchDiscoveredApp(selectedApp, { targetPath: path })
          return ''
        }
      })
    }
  )
  handleYachiyoIpc(IPC_CHANNELS.pickCodexSessionFile, async () => {
    const { dialog } = await import('electron')
    const { homedir } = await import('node:os')
    const result = await dialog.showOpenDialog({
      defaultPath: `${homedir()}/.codex/auth.json`,
      properties: ['openFile'],
      buttonLabel: t('main.dialogs.selectSessionFile'),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })

    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handleYachiyoIpc(IPC_CHANNELS.pickWorkspaceDirectory, async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: t('main.dialogs.selectWorkspace')
    })

    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handleYachiyoIpc(IPC_CHANNELS.pickSyncDirectory, async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: t('main.dialogs.selectSyncFolder')
    })

    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handleYachiyoIpc(IPC_CHANNELS.openSkillsFolder, async () => {
    const { shell } = await import('electron')
    const { mkdir } = await import('node:fs/promises')
    const skillsDir = join(resolveYachiyoDataDir(), 'skills')
    await mkdir(skillsDir, { recursive: true })
    await shell.openPath(skillsDir)
  })
  handleYachiyoIpc(IPC_CHANNELS.runtimeHealth, () => ({ crashed: runtimeCrashed }))
  handleYachiyoIpc(IPC_CHANNELS.restartRuntime, async () => {
    await serverRpc!.reconnect()
    for (const window of BrowserWindow.getAllWindows()) window.webContents.reloadIgnoringCache()
    return { restarted: true }
  })
  handleYachiyoIpc(IPC_CHANNELS.openLogsFolder, async () => {
    const { shell } = await import('electron')
    await shell.openPath(app.getPath('logs'))
  })
  handleYachiyoIpc(IPC_CHANNELS.readAppLogs, (input: { afterByte?: number } | undefined) =>
    readAppLogEntries({ logsDir: app.getPath('logs'), afterByte: input?.afterByte })
  )
  handleYachiyoIpc(
    IPC_CHANNELS.listBrowserAutomationSessions,
    (input: ListBrowserAutomationSessionsInput): BrowserAutomationSessionRecord[] =>
      browserAutomation().listSessions(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.hideBrowserAutomationSession,
    (input: HideBrowserAutomationSessionInput): void => {
      browserAutomation().hideSessionView(input)
    }
  )
  handleYachiyoIpc(
    IPC_CHANNELS.setBrowserAutomationSessionBounds,
    (input: SetBrowserAutomationSessionBoundsInput): BrowserAutomationSessionRecord =>
      browserAutomation().setSessionViewBounds(input)
  )
  registerBrowserPreviewHandlers(browserAutomation)
  ipcMain.removeHandler(IPC_CHANNELS.showBrowserAutomationSession)
  ipcMain.handle(
    IPC_CHANNELS.showBrowserAutomationSession,
    (event, input: ShowBrowserAutomationSessionInput): BrowserAutomationSessionRecord => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window || window.isDestroyed()) {
        throw new Error('Unable to show browser session: source window is unavailable.')
      }
      return browserAutomation().showSessionView({ ...input, window })
    }
  )

  registerProviderBackupHandlers()
  registerGatewayFileHandlers(handleYachiyoIpc)
  registerPngExportHandlers(ipcMain, BrowserWindow)

  ipcMain.removeHandler(IPC_CHANNELS.savePngFile)
  ipcMain.handle(IPC_CHANNELS.savePngFile, async (event, input: SavePngFileInput) => {
    const { dialog } = await import('electron')
    const { writeFile } = await import('node:fs/promises')
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) {
      throw new Error('Unable to save PNG: source window is unavailable.')
    }

    const pngBytes = normalizePngBytes(input.pngData)
    const result = await dialog.showSaveDialog(win, {
      defaultPath: normalizePngFilename(input.defaultFilename),
      filters: [{ name: t('main.dialogs.pngImageFilter'), extensions: ['png'] }]
    })
    if (result.canceled || !result.filePath) {
      return { canceled: true }
    }

    await writeFile(result.filePath, pngBytes)
    return { canceled: false, filePath: result.filePath }
  })

  deferAppQuitUntil({
    app: { onBeforeQuit: (listener) => app.on('before-quit', listener), quit: () => app.quit() },
    cleanup: async () => {
      for (const { reply, timer } of pendingReplies.values()) {
        clearTimeout(timer)
        await reply.onReplyFailure?.()
      }
      pendingReplies.clear()
      updateReceiptCoordinator.releaseAllClaims()
      remoteKeepAwake.dispose()
      if (isInstallingUpdate()) await serverRpc?.shutdown()
      serverRpc?.dispose()
      browserAutomationService?.dispose()
      gatewayHandle = null
    },
    onCleanupError: (error) => console.error('[desktop] detach failed:', error)
  })
  return gatewayHandle
}
export { IPC_CHANNELS }
