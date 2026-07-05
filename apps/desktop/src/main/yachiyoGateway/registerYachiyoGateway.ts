import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  powerMonitor,
  session,
  systemPreferences
} from 'electron'
import { is } from '@electron-toolkit/utils'
import { spawn } from 'child_process'
import { join } from 'node:path'
import { getActivityTracker } from '@yachiyo/runtime/activity/ActivityTracker'
import { resolveActivityTrackingPermissionForSave } from '@yachiyo/runtime/activity/activityTrackingPermission'
import { probeFullActivityAccess } from '@yachiyo/runtime/activity/osascript'

import type {
  AcceptThreadPlanDocumentInput,
  AnswerToolQuestionInput,
  BrowserAutomationSessionRecord,
  ChannelsConfig,
  CompactThreadInput,
  ComposerReasoningSelection,
  DeleteThingInput,
  CreateScheduleInput,
  DeleteMemoryTermInput,
  DeleteMemoryTermResult,
  EditMessageInput,
  GetMemoryTermDocumentInput,
  HideBrowserAutomationSessionInput,
  ImportWebSearchBrowserSessionInput,
  ListBrowserAutomationSessionsInput,
  ListActivitySourceRecordsInput,
  ListSkillsInput,
  ProviderConfig,
  ProviderSettings,
  RenameThingInput,
  RemoveThingSourceInput,
  ResolveSyncConflictInput,
  RetryInput,
  RunModeId,
  SaveThreadInput,
  SearchThreadsAndMessagesInput,
  SearchWorkspaceFilesInput,
  SetBrowserAutomationSessionBoundsInput,
  SettingsConfig,
  SendChatInput,
  ShowBrowserAutomationSessionInput,
  ShowNotificationInput,
  MemoryTermDocument,
  TestSubagentProfileInput,
  ThreadColorTag,
  ThreadModelOverride,
  ToolCallName,
  ToolPreferencesInput,
  TranslateInput,
  JotdownSaveInput,
  UpdateChannelGroupInput,
  UpdateChannelUserInput,
  UpdateScheduleInput,
  UsageStatsInput,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import { createLoopbackRpcHost, type LoopbackRpcHost } from '@yachiyo/shared/rpc/loopbackRpcHost'
import type { RpcMethods } from '@yachiyo/shared/rpc/rpcClient'
import {
  createSqliteYachiyoServer,
  type YachiyoServer
} from '@yachiyo/runtime/app/host/YachiyoServer'
import {
  resolveYachiyoBrowserAutomationProfilePath,
  resolveYachiyoDataDir,
  resolveYachiyoDbPath,
  resolveYachiyoJotdownsDir,
  resolveYachiyoSettingsPath,
  resolveYachiyoSocketPath,
  resolveYachiyoTempWorkspaceRoot
} from '@yachiyo/runtime/config/paths'
import {
  createElectronBrowserAutomationService,
  type BrowserAutomationService
} from '@yachiyo/runtime/services/browserAutomation/electronBrowserAutomationService'
import {
  createElectronBrowserSearchPageFactory,
  type BrowserSearchDiagnosticEvent
} from '@yachiyo/runtime/services/webSearch/electronBrowserSearchSession'
import {
  startCommandSocket,
  type CommandSocketHandle,
  type SendChannelInput
} from '../cli/commandSocket.ts'
import { openThreadWorkspace } from '../electron/openThreadWorkspace.ts'
import { discoverApps } from '../electron/appDiscovery.ts'
import {
  createTelegramService,
  type TelegramService
} from '@yachiyo/runtime/channels/platforms/telegram/telegramService'
import { createQQService, type QQService } from '@yachiyo/runtime/channels/platforms/qq/qqService'
import {
  createQQBotService,
  type QQBotService
} from '@yachiyo/runtime/channels/platforms/qqbot/qqbotService'
import {
  createDiscordService,
  type DiscordService
} from '@yachiyo/runtime/channels/platforms/discord/discordService'
import {
  applyChannelsConfigToPolicy,
  telegramPolicy,
  qqPolicy,
  discordPolicy,
  qqbotPolicy
} from '@yachiyo/runtime/channels/shared/channelPolicy'
import {
  createChannelServiceSupervisor,
  type ChannelServicePlatform,
  type ChannelServiceSupervisor
} from '@yachiyo/runtime/channels/shared/channelServiceLifecycle'
import {
  createScheduleService,
  type ScheduleService
} from '@yachiyo/runtime/services/scheduleService'
import {
  createAutoSyncScheduler,
  type AutoSyncScheduler
} from '@yachiyo/runtime/services/autoSyncScheduler'
import { createJotdownStore } from '@yachiyo/runtime/services/jotdownStore'
import {
  generateDiffForRun,
  restoreToCheckpoint,
  revertFile,
  revertRun
} from '@yachiyo/runtime/services/fileSnapshot/diffGenerator'
import { hashWorkspacePath } from '@yachiyo/runtime/services/fileSnapshot/casStore'
import { listSnapshotRuns } from '@yachiyo/runtime/services/fileSnapshot/snapshotIndex'
import { registerGatewayFileHandlers } from './fileHandlers.ts'
import { broadcastYachiyoEvent, handleYachiyoIpc, showYachiyoNotification } from './ipc.ts'
import { IPC_CHANNELS } from './ipcChannels.ts'
import { normalizePngBytes, normalizePngFilename, type SavePngFileInput } from './pngFile.ts'

/**
 * Phase 1.5 of the runtime process extraction: renderer-facing handlers call
 * the server through an in-process loopback RPC proxy whose transport
 * structured-clones every message, so any payload that could not cross a real
 * MessagePort boundary fails now — before the runtime moves out of this
 * process. Methods excluded here stay on the live server: live-object getters
 * and the two calls served by the rpc:event / rpc:progress channels instead of
 * plain dispatch. (The browser-automation surface lives on a main-owned
 * service now — see browserAutomation() below.)
 */
type RpcSafeYachiyoServer = Omit<
  YachiyoServer,
  | 'subscribe'
  | 'translateStream'
  | 'getStorage'
  | 'getTtlReaper'
  | 'getMemoryService'
  | 'getWebSearchService'
  | 'getImageToTextService'
  | 'getAuxiliaryGenerationService'
>

let server: YachiyoServer | null = null
let serverRpc: LoopbackRpcHost<RpcSafeYachiyoServer> | null = null
// Owned by the gateway, not the server: the sessions hold WebContentsViews,
// which must stay in the main process when the runtime is extracted.
let browserAutomationService: BrowserAutomationService | null = null
let webExternalFetchImpl: typeof globalThis.fetch | undefined
let telegramService: TelegramService | null = null
let qqService: QQService | null = null
let discordService: DiscordService | null = null
let qqbotService: QQBotService | null = null
let channelsConfigForSupervisor: ChannelsConfig | null = null
let channelSupervisor: ChannelServiceSupervisor | null = null
let channelHealthTimer: ReturnType<typeof setInterval> | null = null
let channelRecoveryRegistered = false
let scheduleService: ScheduleService | null = null
let autoSyncScheduler: AutoSyncScheduler | null = null
let commandSocket: CommandSocketHandle | null = null
let commandSocketHealthTimer: ReturnType<typeof setInterval> | null = null
let commandSocketRecoveryRegistered = false
let commandSocketRestartInFlight: Promise<void> | null = null
let fatalRunRecoveryRegistered = false

function rpc(): RpcMethods<RpcSafeYachiyoServer> {
  if (!serverRpc) {
    throw new Error('Yachiyo server is not running')
  }
  return serverRpc.proxy
}

function browserAutomation(): BrowserAutomationService {
  if (!browserAutomationService) {
    throw new Error('Yachiyo server is not running')
  }
  return browserAutomationService
}

function logBrowserSearchDiagnostic(event: BrowserSearchDiagnosticEvent): void {
  const details = {
    profilePath: event.profilePath,
    ...(event.url ? { url: event.url } : {}),
    ...(event.code !== undefined ? { code: String(event.code) } : {}),
    ...(event.details ?? {})
  }
  const suffix = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ')

  console.warn(`[web-search] ${event.event}${suffix ? ` ${suffix}` : ''}`)
}

const COMMAND_SOCKET_HEALTH_INTERVAL_MS = 15_000
const COMMAND_SOCKET_HEALTH_TIMEOUT_MS = 1_000
const CHANNEL_HEALTH_INTERVAL_MS = 60_000

function buildChannelServiceConfigKey(
  cfg: ChannelsConfig,
  platform: ChannelServicePlatform
): string {
  return JSON.stringify({
    platform: cfg[platform],
    groupVerbosity: cfg.groupVerbosity,
    groupCheckIntervalMs: cfg.groupCheckIntervalMs,
    dmCompactTokenThresholdK: cfg.dmCompactTokenThresholdK,
    groupContextWindowK: cfg.groupContextWindowK,
    groupHandoffThresholdK: cfg.groupHandoffThresholdK
  })
}

function createCommandSocketHandle(): CommandSocketHandle {
  return startCommandSocket({
    socketPath: resolveYachiyoSocketPath(),
    onNotification: (input) => showYachiyoNotification(input),
    onSendChannel: (input) => handleSendChannel(input),
    onUpdateChannelGroupStatus: (input) => {
      if (!server) {
        console.error('[channel-group-status] server is not running')
        return
      }
      try {
        const updated = server.updateChannelGroup(input)
        telegramService?.onGroupStatusChange(updated)
        qqService?.onGroupStatusChange(updated)
        discordService?.onGroupStatusChange(updated)
        console.log(
          `[channel-group-status] updated ${updated.platform}:${updated.name} -> ${updated.status}`
        )
      } catch (error) {
        console.error('[channel-group-status] failed:', error)
      }
    },
    onUpdateChannelGroupLabel: (input) => {
      if (!server) {
        console.error('[channel-group-label] server is not running')
        return
      }
      try {
        const updated = server.updateChannelGroup(input)
        telegramService?.onGroupStatusChange(updated)
        qqService?.onGroupStatusChange(updated)
        discordService?.onGroupStatusChange(updated)
        console.log(
          `[channel-group-label] updated ${updated.platform}:${updated.name} label="${updated.label}"`
        )
      } catch (error) {
        console.error('[channel-group-label] failed:', error)
      }
    },
    onMarkThreadReviewed: (input) => {
      if (!server) {
        console.error('[mark-thread-reviewed] server is not running')
        return
      }
      try {
        server.markThreadReviewed(input)
        console.log(`[mark-thread-reviewed] marked ${input.threadId}`)
      } catch (error) {
        console.error('[mark-thread-reviewed] failed:', error)
      }
    },
    onError: (error) => {
      console.error('[command-socket] server error:', error)
      queueMicrotask(() => {
        void restartCommandSocket('socket error')
      })
    }
  })
}

function startCommandSocketNow(reason: string): void {
  commandSocket = createCommandSocketHandle()
  console.log(`[command-socket] listening (${reason})`)
}

async function restartCommandSocket(reason: string): Promise<void> {
  if (commandSocketRestartInFlight) {
    return commandSocketRestartInFlight
  }

  commandSocketRestartInFlight = (async () => {
    const existing = commandSocket
    commandSocket = null

    if (existing) {
      try {
        await existing.close()
      } catch (error) {
        console.error('[command-socket] close before restart failed:', error)
      }
    }

    startCommandSocketNow(reason)
  })().finally(() => {
    commandSocketRestartInFlight = null
  })

  return commandSocketRestartInFlight
}

async function ensureCommandSocketHealthy(reason: string): Promise<void> {
  if (commandSocketRestartInFlight) {
    return commandSocketRestartInFlight
  }

  const handle = commandSocket
  if (!handle) {
    return restartCommandSocket(reason)
  }

  const healthy = await handle.healthCheck(COMMAND_SOCKET_HEALTH_TIMEOUT_MS)
  if (!healthy) {
    console.warn(`[command-socket] unhealthy; restarting (${reason})`)
    await restartCommandSocket(reason)
  }
}

function registerCommandSocketRecovery(): void {
  if (commandSocketRecoveryRegistered) {
    return
  }

  commandSocketRecoveryRegistered = true
  commandSocketHealthTimer = setInterval(() => {
    void ensureCommandSocketHealthy('periodic health check')
  }, COMMAND_SOCKET_HEALTH_INTERVAL_MS)

  const scheduleHealthCheck = (reason: string, delayMs = 0): void => {
    setTimeout(() => {
      void ensureCommandSocketHealthy(reason)
    }, delayMs)
  }

  powerMonitor.on('lock-screen', () => scheduleHealthCheck('lock-screen', 1_000))
  powerMonitor.on('unlock-screen', () => scheduleHealthCheck('unlock-screen'))
  powerMonitor.on('resume', () => scheduleHealthCheck('resume'))
  powerMonitor.on('user-did-become-active', () => scheduleHealthCheck('user-did-become-active'))
}

function getChannelSupervisor(): ChannelServiceSupervisor {
  if (channelSupervisor) return channelSupervisor

  channelSupervisor = createChannelServiceSupervisor({
    telegram: {
      label: 'telegram',
      enabled: () => {
        const token = channelsConfigForSupervisor?.telegram?.botToken?.trim()
        return Boolean(server && channelsConfigForSupervisor?.telegram?.enabled && token)
      },
      configKey: () => buildChannelServiceConfigKey(channelsConfigForSupervisor!, 'telegram'),
      create: () => {
        const cfg = channelsConfigForSupervisor!
        const token = cfg.telegram!.botToken!.trim()
        return createTelegramService({
          botToken: token,
          model: cfg.telegram?.model,
          server: server!,
          groupConfig: cfg.telegram?.group,
          botUsername: undefined,
          groupVerbosity: cfg.groupVerbosity,
          groupCheckIntervalMs: cfg.groupCheckIntervalMs,
          policy: applyChannelsConfigToPolicy(telegramPolicy, cfg)
        })
      },
      onServiceChange: (service) => {
        telegramService = service as TelegramService | null
      }
    },
    qq: {
      label: 'qq',
      enabled: () => {
        const wsUrl = channelsConfigForSupervisor?.qq?.wsUrl?.trim()
        return Boolean(server && channelsConfigForSupervisor?.qq?.enabled && wsUrl)
      },
      configKey: () => buildChannelServiceConfigKey(channelsConfigForSupervisor!, 'qq'),
      create: () => {
        const cfg = channelsConfigForSupervisor!
        const wsUrl = cfg.qq!.wsUrl!.trim()
        return createQQService({
          wsUrl,
          token: cfg.qq?.token,
          model: cfg.qq?.model,
          server: server!,
          groupConfig: cfg.qq?.group,
          botQQId: undefined,
          groupVerbosity: cfg.groupVerbosity,
          groupCheckIntervalMs: cfg.groupCheckIntervalMs,
          policy: applyChannelsConfigToPolicy(qqPolicy, cfg)
        })
      },
      onServiceChange: (service) => {
        qqService = service as QQService | null
      }
    },
    discord: {
      label: 'discord',
      enabled: () => {
        const token = channelsConfigForSupervisor?.discord?.botToken?.trim()
        return Boolean(server && channelsConfigForSupervisor?.discord?.enabled && token)
      },
      configKey: () => buildChannelServiceConfigKey(channelsConfigForSupervisor!, 'discord'),
      create: () => {
        const cfg = channelsConfigForSupervisor!
        const token = cfg.discord!.botToken!.trim()
        return createDiscordService({
          botToken: token,
          model: cfg.discord?.model,
          server: server!,
          groupConfig: cfg.discord?.group,
          groupVerbosity: cfg.groupVerbosity,
          groupCheckIntervalMs: cfg.groupCheckIntervalMs,
          policy: applyChannelsConfigToPolicy(discordPolicy, cfg)
        })
      },
      onServiceChange: (service) => {
        discordService = service as DiscordService | null
      }
    },
    qqbot: {
      label: 'qqbot',
      enabled: () => {
        const appId = channelsConfigForSupervisor?.qqbot?.appId?.trim()
        const clientSecret = channelsConfigForSupervisor?.qqbot?.clientSecret?.trim()
        return Boolean(
          server && channelsConfigForSupervisor?.qqbot?.enabled && appId && clientSecret
        )
      },
      configKey: () => buildChannelServiceConfigKey(channelsConfigForSupervisor!, 'qqbot'),
      create: () => {
        const cfg = channelsConfigForSupervisor!
        return createQQBotService({
          appId: cfg.qqbot!.appId!.trim(),
          clientSecret: cfg.qqbot!.clientSecret!.trim(),
          model: cfg.qqbot?.model,
          server: server!,
          policy: applyChannelsConfigToPolicy(qqbotPolicy, cfg)
        })
      },
      onServiceChange: (service) => {
        qqbotService = service as QQBotService | null
      }
    }
  })

  return channelSupervisor
}

function registerChannelRecovery(): void {
  if (channelRecoveryRegistered) return

  channelRecoveryRegistered = true
  channelHealthTimer = setInterval(() => {
    void channelSupervisor?.poke('periodic health check')
  }, CHANNEL_HEALTH_INTERVAL_MS)

  const scheduleHealthCheck = (reason: string, delayMs = 0): void => {
    setTimeout(() => {
      void channelSupervisor?.poke(reason)
    }, delayMs)
  }

  powerMonitor.on('lock-screen', () => scheduleHealthCheck('lock-screen', 1_000))
  powerMonitor.on('unlock-screen', () => scheduleHealthCheck('unlock-screen'))
  powerMonitor.on('resume', () => scheduleHealthCheck('resume'))
  powerMonitor.on('user-did-become-active', () => scheduleHealthCheck('user-did-become-active'))
}

function toFatalRunError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const trimmed = message.trim()
  return trimmed
    ? `Fatal main-process error interrupted the run: ${trimmed}`
    : 'Fatal main-process error interrupted the run.'
}

function registerFatalRunRecovery(): void {
  if (fatalRunRecoveryRegistered) {
    return
  }

  process.on('uncaughtExceptionMonitor', (error) => {
    try {
      server?.recoverInterruptedRuns(toFatalRunError(error))
    } catch (recoveryError) {
      console.error(
        '[yachiyo] failed to persist interrupted runs after a fatal error',
        recoveryError
      )
    }
  })

  // Keep the main process alive and prevent Electron error dialogs when
  // sandboxed code (e.g. jsRepl timers) leaks an async error.
  process.on('uncaughtException', (error) => {
    console.error('[yachiyo] uncaughtException:', error)
  })

  process.on('unhandledRejection', (reason) => {
    console.error('[yachiyo] unhandledRejection:', reason)
  })

  fatalRunRecoveryRegistered = true
}

import { getPerfMonitor, stopPerfMonitor } from '@yachiyo/runtime/services/perfMonitor'

function handleSendChannel(input: SendChannelInput): void {
  if (!server) {
    console.error('[send-channel] server is not running')
    return
  }

  const storage = server.getStorage()
  const channelUser = storage.getChannelUser(input.id)
  const channelGroup = channelUser ? undefined : storage.getChannelGroup(input.id)

  if (!channelUser && !channelGroup) {
    console.error(`[send-channel] unknown channel user or group: ${input.id}`)
    return
  }

  const platform = channelUser?.platform ?? channelGroup!.platform
  const externalId = channelUser?.externalUserId ?? channelGroup!.externalGroupId

  void (async () => {
    if (platform === 'telegram') {
      if (!telegramService) throw new Error('Telegram service is not running')
      await telegramService.sendMessage(externalId, input.message)
    } else if (platform === 'qq') {
      if (!qqService) throw new Error('QQ service is not running')
      const numericId = Number(externalId)
      if (channelUser) {
        await qqService.sendPrivateMessage(numericId, input.message)
      } else {
        await qqService.sendGroupMessage(numericId, input.message)
      }
    } else if (platform === 'discord') {
      if (!discordService) throw new Error('Discord service is not running')
      await discordService.sendMessage(externalId, input.message)
    } else if (platform === 'qqbot') {
      if (!qqbotService) throw new Error('QQBot service is not running')
      await qqbotService.sendMessage(externalId, input.message)
    } else {
      throw new Error(`Unsupported platform: ${platform}`)
    }
    console.log(`[send-channel] sent to ${platform}:${externalId}`)
  })().catch((err) => {
    console.error('[send-channel] failed:', err)
  })
}

function createConfiguredServer(
  input: {
    jotdownStore?: import('@yachiyo/runtime/services/jotdownStore').JotdownStore
    webExternalFetchImpl?: typeof globalThis.fetch
  } = {}
): YachiyoServer {
  browserAutomationService = createElectronBrowserAutomationService({
    profilePath: resolveYachiyoBrowserAutomationProfilePath()
  })
  const nextServer = createSqliteYachiyoServer({
    dbPath: resolveYachiyoDbPath(),
    settingsPath: resolveYachiyoSettingsPath(),
    developmentMode: is.dev,
    seedPresetProviders: true,
    fetchImpl: (input, init) =>
      net.fetch(input instanceof URL ? input.toString() : (input as string | Request), init),
    webExternalFetchImpl: input.webExternalFetchImpl,
    jotdownStore: input.jotdownStore,
    browserAutomationService,
    browserSearchPageFactory: createElectronBrowserSearchPageFactory({
      log: logBrowserSearchDiagnostic
    })
  })
  serverRpc = createLoopbackRpcHost<RpcSafeYachiyoServer>(nextServer, {
    subscribe: (listener) => nextServer.subscribe(listener)
  })
  serverRpc.client.subscribe((event) => broadcastYachiyoEvent(event as YachiyoServerEvent))
  nextServer.getTtlReaper().start()
  return nextServer
}

async function stopLiveServices(): Promise<void> {
  autoSyncScheduler?.stop()
  autoSyncScheduler = null
  scheduleService?.stop()
  scheduleService = null

  await channelSupervisor?.stopAll('live services stopping')
  telegramService = null
  qqService = null
  discordService = null
  qqbotService = null
}

async function startLiveServices(): Promise<void> {
  if (!server) {
    return
  }

  scheduleService = createScheduleService({
    server: {
      createThread: (input) => server!.createThread(input),
      setThreadModelOverride: (input) => server!.setThreadModelOverride(input),
      setThreadIcon: (input) => server!.setThreadIcon(input),
      sendChat: (input) => server!.sendChat(input),
      archiveThread: (input) => server!.archiveThread(input),
      showNotification: (input) => showYachiyoNotification(input),
      subscribe: (listener) => server!.subscribe(listener)
    },
    storage: server.getStorage(),
    createId: () => server!.generateId(),
    timestamp: () => new Date().toISOString(),
    tempWorkspaceDir: resolveYachiyoTempWorkspaceRoot()
  })
  // In dev mode, schedules are skipped by default to avoid unintended automated
  // runs. Set YACHIYO_DEV_SCHEDULES=1 (or run `pnpm dev:schedules`) to opt in.
  if (!is.dev || process.env['YACHIYO_DEV_SCHEDULES']) {
    scheduleService.start()
  }

  // Keep iCloud sync flowing automatically. The scheduler no-ops until the user
  // has enabled sync (runAutoSyncCycle gates on readiness), so it's safe to run
  // in dev too — it just mirrors files the user already opted into syncing.
  autoSyncScheduler = createAutoSyncScheduler({
    runSync: () => server!.runAutoSyncCycle(),
    subscribe: (listener) => server!.subscribe(listener),
    onError: (error) => console.warn('[auto-sync]', error instanceof Error ? error.message : error)
  })
  autoSyncScheduler.start()

  if (!is.dev || process.env['YACHIYO_DEV_CHANNELS']) {
    const channelsConfig = server.getChannelsConfig()
    channelsConfigForSupervisor = channelsConfig
    await getChannelSupervisor().reconcileAll('initial startup')
  }
}

async function restartServerForDemoModeChange(): Promise<void> {
  const previousServer = server
  await stopLiveServices()
  serverRpc?.dispose()
  serverRpc = null
  browserAutomationService?.dispose()
  browserAutomationService = null
  await previousServer?.close()
  server = createConfiguredServer({ webExternalFetchImpl })
  await startLiveServices()

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.reloadIgnoringCache()
    }
  }
}

async function resolveActivityTrackingPermission(
  config: SettingsConfig,
  currentConfig: SettingsConfig
): Promise<SettingsConfig> {
  return resolveActivityTrackingPermissionForSave(config, currentConfig, {
    platform: process.platform,
    requestAccessibilityTrust: () => systemPreferences.isTrustedAccessibilityClient(true),
    probeFullActivityAccess
  })
}

export function registerYachiyoGateway(): YachiyoServer {
  if (server) {
    return server
  }

  // Route global fetch through Electron's net module so libraries using the
  // global fetch (e.g. discord.js) go through Chromium's network stack.
  // The default session keeps strict TLS — provider API keys travel over it.
  // Note: Telegraf uses node-fetch internally and needs its own proxy agent.
  globalThis.fetch = (input, init?) =>
    net.fetch(input instanceof URL ? input.toString() : (input as string | Request), init)

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
  webExternalFetchImpl = (input, init?) =>
    webExternalSession.fetch(
      input instanceof URL ? input.toString() : (input as string | Request),
      init
    )

  const jotdownStore = createJotdownStore(resolveYachiyoJotdownsDir())
  server = createConfiguredServer({ jotdownStore, webExternalFetchImpl })
  registerFatalRunRecovery()

  // Start channel services if already configured.
  // In dev mode, channels are skipped by default to avoid unintended outbound
  // connections. Set YACHIYO_DEV_CHANNELS=1 (or run `pnpm dev:channels`) to opt in.
  void startLiveServices()

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

  // Unix domain socket for CLI commands (notifications, send-channel, etc.)
  startCommandSocketNow('initial startup')
  registerCommandSocketRecovery()
  registerChannelRecovery()

  handleYachiyoIpc(IPC_CHANNELS.searchThreadsAndMessages, (input: SearchThreadsAndMessagesInput) =>
    rpc().searchThreadsAndMessages(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.searchWorkspaceFiles, (input: SearchWorkspaceFilesInput) =>
    rpc().searchWorkspaceFiles(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.listThings, (input?: { includeInactive?: boolean }) =>
    rpc().listThings(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.getThing, (input: { name: string }) => rpc().getThing(input))
  handleYachiyoIpc(IPC_CHANNELS.restoreThing, (input: { name: string }) =>
    rpc().restoreThing(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.renameThing, (input: RenameThingInput) => rpc().renameThing(input))
  handleYachiyoIpc(IPC_CHANNELS.deleteThing, (input: DeleteThingInput) => rpc().deleteThing(input))
  handleYachiyoIpc(IPC_CHANNELS.removeThingSource, (input: RemoveThingSourceInput) =>
    rpc().removeThingSource(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.continueThingInNewChat, (input: { name: string }) =>
    rpc().continueThingInNewChat(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.bootstrap, () => rpc().bootstrap())
  handleYachiyoIpc(
    IPC_CHANNELS.createThread,
    (input?: {
      workspacePath?: string
      createdFromEssentialId?: string
      privacyMode?: boolean
      modelOverride?: ThreadModelOverride
      enabledTools?: ToolCallName[]
      runMode?: RunModeId
      reasoningEffort?: ComposerReasoningSelection
    }) => rpc().createThread(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.createBranch, (input: { threadId: string; messageId: string }) =>
    rpc().createBranch(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.compactThreadToAnotherThread, (input: CompactThreadInput) =>
    rpc().compactThreadToAnotherThread(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.createFolderForThreads, (input: { threadIds: string[] }) =>
    rpc().createFolderForThreads(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.renameFolder, (input: { folderId: string; title: string }) =>
    rpc().renameFolder(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.setFolderColor,
    (input: { folderId: string; colorTag: string | null }) => rpc().setFolderColor(input as never)
  )
  handleYachiyoIpc(IPC_CHANNELS.deleteFolder, (input: { folderId: string }) =>
    rpc().deleteFolder(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.moveThreadToFolder,
    (input: { threadId: string; folderId: string | null }) => rpc().moveThreadToFolder(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.renameThread, (input: { threadId: string; title: string }) =>
    rpc().renameThread(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.setThreadColor,
    (input: { threadId: string; colorTag: ThreadColorTag | null }) => rpc().setThreadColor(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.setThreadIcon, (input: { threadId: string; icon: string | null }) =>
    rpc().setThreadIcon(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.showEmojiPanel, () => {
    app.showEmojiPanel()
  })
  handleYachiyoIpc(IPC_CHANNELS.archiveThread, (input: { threadId: string }) =>
    rpc().archiveThread(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.deleteThread, (input: { threadId: string }) =>
    rpc().deleteThread(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.openThreadWorkspace, (input: { threadId: string }) =>
    rpc()
      .openThreadWorkspace(input)
      .then((workspacePath) => openThreadWorkspace(input.threadId, workspacePath))
  )
  handleYachiyoIpc(
    IPC_CHANNELS.getThreadWorkspaceChangeDecision,
    (input: { threadId: string; workspacePath?: string | null }) =>
      rpc().getThreadWorkspaceChangeDecision(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.readThreadPlanDocument, (input: { threadId: string }) =>
    rpc().readThreadPlanDocument(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.acceptThreadPlanDocument, (input: AcceptThreadPlanDocumentInput) =>
    rpc().acceptThreadPlanDocument(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.listDiscoveredApps, () => discoverApps())
  handleYachiyoIpc(
    IPC_CHANNELS.openWorkspaceWithApp,
    async (input: { threadId: string; appName: string }) => {
      const workspacePath = await rpc().openThreadWorkspace({ threadId: input.threadId })
      await openThreadWorkspace(input.threadId, workspacePath, {
        openPath: (path) =>
          new Promise<string>((resolve, reject) => {
            const child = spawn('open', ['-a', input.appName, path])
            child.on('close', (code) => {
              if (code === 0) {
                resolve('')
              } else {
                reject(new Error(`Failed to open "${input.appName}" (exit code ${code})`))
              }
            })
            child.on('error', reject)
          })
      })
    }
  )
  handleYachiyoIpc(
    IPC_CHANNELS.updateThreadWorkspace,
    (input: { threadId: string; workspacePath?: string | null; confirmed?: boolean }) =>
      rpc().updateThreadWorkspace(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.pickCodexSessionFile, async () => {
    const { dialog } = await import('electron')
    const { homedir } = await import('node:os')
    const result = await dialog.showOpenDialog({
      defaultPath: `${homedir()}/.codex/auth.json`,
      properties: ['openFile'],
      buttonLabel: 'Select session file',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })

    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handleYachiyoIpc(IPC_CHANNELS.pickWorkspaceDirectory, async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Select workspace'
    })

    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handleYachiyoIpc(IPC_CHANNELS.pickSyncDirectory, async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Select sync folder'
    })

    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handleYachiyoIpc(IPC_CHANNELS.restoreThread, (input: { threadId: string }) =>
    rpc().restoreThread(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.saveToolPreferences, (input: ToolPreferencesInput) =>
    rpc().saveToolPreferences(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.clearRecapText, (input: { threadId: string }) =>
    rpc().clearRecapText(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.requestRecap, (input: { threadId: string }) =>
    rpc().requestRecap(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.sendChat, (input: SendChatInput) => {
    const safeInput: SendChatInput = { ...input }
    delete (
      safeInput as SendChatInput & {
        toolPreset?: unknown
      }
    ).toolPreset
    return rpc().sendChat(safeInput)
  })
  handleYachiyoIpc(IPC_CHANNELS.retryMessage, (input: RetryInput) => rpc().retryMessage(input))
  handleYachiyoIpc(IPC_CHANNELS.saveThread, (input: SaveThreadInput) => rpc().saveThread(input))
  handleYachiyoIpc(
    IPC_CHANNELS.selectReplyBranch,
    (input: { threadId: string; assistantMessageId: string }) => rpc().selectReplyBranch(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.deleteMessage, (input: { threadId: string; messageId: string }) =>
    rpc().deleteMessageFromHere(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.editMessage, (input: EditMessageInput) => rpc().editMessage(input))
  handleYachiyoIpc(IPC_CHANNELS.cancelRun, (input: { runId: string }) => rpc().cancelRun(input))
  handleYachiyoIpc(IPC_CHANNELS.withdrawPendingSteer, (input: { threadId: string }) =>
    rpc().withdrawPendingSteer(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.answerToolQuestion, (input: AnswerToolQuestionInput) =>
    rpc().answerToolQuestion(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.getConfig, () => rpc().getConfig())
  handleYachiyoIpc(IPC_CHANNELS.getSoulDocument, () => rpc().getSoulDocument())
  handleYachiyoIpc(IPC_CHANNELS.addSoulTrait, (input: { trait: string }) =>
    rpc().addSoulTrait(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.deleteSoulTrait, (input: { trait: string }) =>
    rpc().deleteSoulTrait(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.getMemoryTermDocument,
    (input?: GetMemoryTermDocumentInput): Promise<MemoryTermDocument> =>
      rpc().getMemoryTermDocument(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.deleteMemoryTerm,
    (input: DeleteMemoryTermInput): Promise<DeleteMemoryTermResult> => rpc().deleteMemoryTerm(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.listActivitySourceRecords,
    (input?: ListActivitySourceRecordsInput) => rpc().listActivitySourceRecords(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.getUserDocument, () => rpc().getUserDocument())
  handleYachiyoIpc(IPC_CHANNELS.testSubagentProfile, (input: TestSubagentProfileInput) =>
    rpc().testSubagentProfile(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.getSettings, () => rpc().getSettings())
  handleYachiyoIpc(IPC_CHANNELS.getSyncStatus, () => rpc().getSyncStatus())
  handleYachiyoIpc(IPC_CHANNELS.initSync, () => rpc().initSync())
  handleYachiyoIpc(IPC_CHANNELS.runSyncNow, () => rpc().runSyncNow())
  handleYachiyoIpc(IPC_CHANNELS.listSyncConflicts, () => rpc().listSyncConflicts())
  handleYachiyoIpc(IPC_CHANNELS.resolveSyncConflict, (input: ResolveSyncConflictInput) =>
    rpc().resolveSyncConflict(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.saveConfig, async (input: SettingsConfig) => {
    const currentConfig = await rpc().getConfig()
    const demoModeBeforeSave = is.dev && currentConfig.general?.demoMode === true
    const configToSave = await resolveActivityTrackingPermission(input, currentConfig)
    const saved = await rpc().saveConfig(configToSave)
    const demoModeAfterSave = is.dev && saved.general?.demoMode === true

    if (demoModeBeforeSave !== demoModeAfterSave) {
      setTimeout(() => {
        void restartServerForDemoModeChange()
      }, 0)
    }

    // Sync activity tracking settings
    const activityTracking = saved.general?.activityTracking ?? {
      mode: 'simple' as const,
      ocr: { enabled: false, excludedApps: [] }
    }
    const tracker = getActivityTracker(activityTracking.mode)
    tracker.setMode(
      activityTracking.mode,
      activityTracking.mode === 'full'
        ? { fullModeAvailable: activityTracking.accessibilityDenied !== true }
        : undefined
    )
    tracker.setOcrConfig(activityTracking.ocr)

    return saved
  })
  handleYachiyoIpc(IPC_CHANNELS.saveUserDocument, (input: { content: string }) =>
    rpc().saveUserDocument(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.saveSettings, (input: Partial<ProviderSettings>) =>
    rpc().saveSettings(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.upsertProvider, (input: ProviderConfig) =>
    rpc().upsertProvider(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.removeProvider, (input: { name: string }) =>
    rpc().removeProvider(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.enableProviderModel, (input: { name: string; model: string }) =>
    rpc().enableProviderModel(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.disableProviderModel, (input: { name: string; model: string }) =>
    rpc().disableProviderModel(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.fetchProviderModels, (input: ProviderConfig) =>
    rpc().fetchProviderModels(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.listWebSearchBrowserImportSources, () =>
    rpc().listWebSearchBrowserImportSources()
  )
  handleYachiyoIpc(IPC_CHANNELS.listSkills, (input: ListSkillsInput | undefined) =>
    rpc().listSkills(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.openSkillsFolder, async () => {
    const { shell } = await import('electron')
    const { mkdir } = await import('node:fs/promises')
    const skillsDir = join(resolveYachiyoDataDir(), 'skills')
    await mkdir(skillsDir, { recursive: true })
    await shell.openPath(skillsDir)
  })
  handleYachiyoIpc(
    IPC_CHANNELS.importWebSearchBrowserSession,
    (input: ImportWebSearchBrowserSessionInput) => rpc().importWebSearchBrowserSession(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.listBrowserAutomationSessions,
    (input: ListBrowserAutomationSessionsInput): BrowserAutomationSessionRecord[] =>
      browserAutomation().listSessions(input)
  )
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
  handleYachiyoIpc(
    IPC_CHANNELS.setThreadPrivacyMode,
    (input: { threadId: string; enabled: boolean }) => rpc().setThreadPrivacyMode(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.setThreadModelOverride,
    (input: { threadId: string; modelOverride: ThreadModelOverride | null }) =>
      rpc().setThreadModelOverride(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.setThreadReasoningEffort,
    (input: { threadId: string; reasoningEffort: ComposerReasoningSelection | null }) =>
      rpc().setThreadReasoningEffort(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.setThreadToolMode,
    (input: { threadId: string; enabledTools: ToolCallName[]; runMode?: RunModeId }) =>
      rpc().setThreadToolMode(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.setThreadRuntimeBinding,
    (input: {
      threadId: string
      runtimeBinding: import('@yachiyo/shared/protocol').ThreadRuntimeBinding | null
    }) => rpc().setThreadRuntimeBinding(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.regenerateThreadTitle, (input: { threadId: string }) =>
    rpc().regenerateThreadTitle(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.starThread, (input: { threadId: string; starred: boolean }) =>
    rpc().starThread(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.loadThreadData,
    (input: { threadId: string; includeMessages?: boolean }) =>
      rpc().loadThreadData(input.threadId, { includeMessages: input.includeMessages })
  )
  handleYachiyoIpc(IPC_CHANNELS.listBackgroundTasks, (input?: { threadId?: string }) =>
    rpc().listBackgroundTasks(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.getBackgroundTaskLog,
    (input: { threadId: string; taskId: string; maxBytes?: number }) =>
      rpc().getBackgroundTaskLog(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.cancelBackgroundTask, (input: { taskId: string }) =>
    rpc().cancelBackgroundTask(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.listExternalThreads, () => rpc().listExternalThreads())
  handleYachiyoIpc(IPC_CHANNELS.listChannelUsers, () => rpc().listChannelUsers())
  handleYachiyoIpc(IPC_CHANNELS.updateChannelUser, (input: UpdateChannelUserInput) =>
    rpc().updateChannelUser(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.listChannelGroups, () => rpc().listChannelGroups())
  handleYachiyoIpc(IPC_CHANNELS.updateChannelGroup, async (input: UpdateChannelGroupInput) => {
    const updated = await rpc().updateChannelGroup(input)
    // Notify running channel services so they can start/stop monitors.
    telegramService?.onGroupStatusChange(updated)
    qqService?.onGroupStatusChange(updated)
    discordService?.onGroupStatusChange(updated)
    return updated
  })
  handleYachiyoIpc(IPC_CHANNELS.clearGroupMonitorBuffer, async (input: { groupId: string }) => {
    await rpc().startClearChannelGroupHistory(input)
    telegramService?.clearGroupMessages(input.groupId)
    qqService?.clearGroupMessages(input.groupId)
    discordService?.clearGroupMessages(input.groupId)
  })
  handleYachiyoIpc(IPC_CHANNELS.getChannelsConfig, () => rpc().getChannelsConfig())
  handleYachiyoIpc(IPC_CHANNELS.saveChannelsConfig, async (input: ChannelsConfig) => {
    const saved = await rpc().saveChannelsConfig(input)
    channelsConfigForSupervisor = saved
    await getChannelSupervisor().reconcileAll('config changed')
    return saved
  })
  handleYachiyoIpc(
    IPC_CHANNELS.restartChannelService,
    async (input: { platform: 'telegram' | 'qq' | 'discord' | 'qqbot' | 'all' }) => {
      channelsConfigForSupervisor = await rpc().getChannelsConfig()
      if (input.platform === 'all') {
        await getChannelSupervisor().restartAll('manual restart')
        return
      }
      await getChannelSupervisor().restart(input.platform, 'manual restart')
    }
  )
  // Schedule CRUD
  handleYachiyoIpc(IPC_CHANNELS.listSchedules, () => rpc().listSchedules())
  handleYachiyoIpc(IPC_CHANNELS.createSchedule, async (input: CreateScheduleInput) => {
    const schedule = await rpc().createSchedule(input)
    scheduleService?.reload()
    return schedule
  })
  handleYachiyoIpc(IPC_CHANNELS.updateSchedule, async (input: UpdateScheduleInput) => {
    const schedule = await rpc().updateSchedule(input)
    scheduleService?.reload()
    return schedule
  })
  handleYachiyoIpc(IPC_CHANNELS.deleteSchedule, async (input: { id: string }) => {
    await rpc().deleteSchedule(input.id)
    scheduleService?.reload()
  })
  handleYachiyoIpc(IPC_CHANNELS.enableSchedule, async (input: { id: string }) => {
    const result = await rpc().enableSchedule(input.id)
    scheduleService?.reload()
    return result
  })
  handleYachiyoIpc(IPC_CHANNELS.disableSchedule, async (input: { id: string }) => {
    const result = await rpc().disableSchedule(input.id)
    scheduleService?.reload()
    return result
  })
  handleYachiyoIpc(IPC_CHANNELS.listScheduleRuns, (input: { scheduleId: string; limit?: number }) =>
    rpc().listScheduleRuns(input.scheduleId, input.limit)
  )
  handleYachiyoIpc(IPC_CHANNELS.listRecentScheduleRuns, (input?: { limit?: number }) =>
    rpc().listRecentScheduleRuns(input?.limit)
  )
  handleYachiyoIpc(IPC_CHANNELS.triggerScheduleNow, async (input: { scheduleId: string }) => {
    await scheduleService?.triggerScheduleNow(input.scheduleId)
  })
  handleYachiyoIpc(IPC_CHANNELS.markThreadAsRead, (input: { threadId: string }) =>
    rpc().markThreadAsRead(input)
  )

  registerGatewayFileHandlers(handleYachiyoIpc)

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
      filters: [{ name: 'PNG image', extensions: ['png'] }]
    })
    if (result.canceled || !result.filePath) {
      return { canceled: true }
    }

    await writeFile(result.filePath, pngBytes)
    return { canceled: false, filePath: result.filePath }
  })

  handleYachiyoIpc(
    IPC_CHANNELS.downloadRemoteImageForMessage,
    (input: { threadId: string; messageId: string; url: string }) =>
      rpc().downloadRemoteImageForMessage(input)
  )

  ipcMain.removeHandler(IPC_CHANNELS.translate)
  ipcMain.handle(IPC_CHANNELS.translate, async (event, input: TranslateInput) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!serverRpc) {
      throw new Error('Yachiyo server is not running')
    }
    // translateStream's trailing onDelta callback maps onto the RPC progress
    // channel; deltas cross the same clone boundary the extraction will use.
    return serverRpc.client.call('translateStream', [input], {
      onProgress: (delta) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('translator:delta', delta)
        }
      }
    })
  })

  // ── Jotdown handlers ──────────────────────────────────────────────

  handleYachiyoIpc(IPC_CHANNELS.jotdownList, () => jotdownStore.list())
  handleYachiyoIpc(IPC_CHANNELS.jotdownLoad, (input: { id: string }) => jotdownStore.load(input.id))
  handleYachiyoIpc(IPC_CHANNELS.jotdownCreate, () => jotdownStore.create())
  handleYachiyoIpc(IPC_CHANNELS.jotdownSave, (input: JotdownSaveInput) => jotdownStore.save(input))
  handleYachiyoIpc(IPC_CHANNELS.jotdownDelete, (input: { id: string }) =>
    jotdownStore.delete(input.id)
  )
  handleYachiyoIpc(IPC_CHANNELS.pruneEmptyTemporaryWorkspaces, () =>
    rpc().pruneEmptyTemporaryWorkspaces()
  )

  handleYachiyoIpc(IPC_CHANNELS.getUsageStats, (input: UsageStatsInput) =>
    rpc().getUsageStats(input)
  )

  handleYachiyoIpc(IPC_CHANNELS.getPerfStats, () => getPerfMonitor().getStats())

  handleYachiyoIpc(
    IPC_CHANNELS.getSnapshotDiff,
    (input: { runId: string; workspacePath: string }) =>
      generateDiffForRun(input.workspacePath, input.runId)
  )

  handleYachiyoIpc(
    IPC_CHANNELS.revertSnapshotFile,
    (input: { runId: string; workspacePath: string; relativePath: string }) =>
      revertFile(input.workspacePath, input.runId, input.relativePath)
  )

  handleYachiyoIpc(
    IPC_CHANNELS.revertSnapshotRun,
    (input: { runId: string; workspacePath: string }) => revertRun(input.workspacePath, input.runId)
  )

  handleYachiyoIpc(IPC_CHANNELS.listRunSnapshots, (input: { workspacePath: string }) =>
    listSnapshotRuns(hashWorkspacePath(input.workspacePath))
  )

  handleYachiyoIpc(
    IPC_CHANNELS.restoreToCheckpoint,
    async (input: { runId: string; workspacePath: string }) => {
      const destroyedRunIds = await restoreToCheckpoint(input.workspacePath, input.runId)
      const storage = server!.getStorage()
      for (const id of destroyedRunIds) {
        storage.updateRunSnapshot(id, { fileCount: 0 })
      }
      return destroyedRunIds
    }
  )

  app.once('before-quit', () => {
    stopPerfMonitor()
    if (commandSocketHealthTimer) {
      clearInterval(commandSocketHealthTimer)
      commandSocketHealthTimer = null
    }
    if (channelHealthTimer) {
      clearInterval(channelHealthTimer)
      channelHealthTimer = null
    }
    autoSyncScheduler?.stop()
    autoSyncScheduler = null
    scheduleService?.stop()
    scheduleService = null
    void channelSupervisor?.stopAll('before quit').catch(() => {})
    channelSupervisor = null
    telegramService = null
    qqService = null
    discordService = null
    qqbotService = null
    commandSocketRestartInFlight = null
    void commandSocket?.close()
    commandSocket = null
    serverRpc?.dispose()
    serverRpc = null
    browserAutomationService?.dispose()
    browserAutomationService = null
    void server?.close()
    server = null
  })

  return server
}

export { IPC_CHANNELS }
