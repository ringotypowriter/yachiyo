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
  UsageStatsInput
} from '@yachiyo/shared/protocol'
import {
  createSqliteYachiyoServer,
  type YachiyoServer
} from '@yachiyo/runtime/app/host/YachiyoServer'
import {
  resolveYachiyoDataDir,
  resolveYachiyoDbPath,
  resolveYachiyoJotdownsDir,
  resolveYachiyoSettingsPath,
  resolveYachiyoSocketPath,
  resolveYachiyoTempWorkspaceRoot
} from '@yachiyo/runtime/config/paths'
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
  createScheduleService,
  type ScheduleService
} from '@yachiyo/runtime/services/scheduleService'
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

let server: YachiyoServer | null = null
let webExternalFetchImpl: typeof globalThis.fetch | undefined
let telegramService: TelegramService | null = null
let qqService: QQService | null = null
let discordService: DiscordService | null = null
let qqbotService: QQBotService | null = null
let scheduleService: ScheduleService | null = null
let commandSocket: CommandSocketHandle | null = null
let commandSocketHealthTimer: ReturnType<typeof setInterval> | null = null
let commandSocketRecoveryRegistered = false
let commandSocketRestartInFlight: Promise<void> | null = null
let fatalRunRecoveryRegistered = false

const COMMAND_SOCKET_HEALTH_INTERVAL_MS = 15_000
const COMMAND_SOCKET_HEALTH_TIMEOUT_MS = 1_000

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

async function applyTelegramConfig(cfg: ChannelsConfig): Promise<void> {
  const token = cfg.telegram?.botToken?.trim()
  const enabled = cfg.telegram?.enabled ?? false

  if (telegramService) {
    console.log('[telegram] stopping existing service')
    const old = telegramService
    telegramService = null
    try {
      await old.stop()
    } catch (e) {
      console.error('[telegram] stop error', e)
    }
  }

  if (!enabled || !token || !server) {
    console.log(`[telegram] service not started (enabled=${enabled}, hasToken=${Boolean(token)})`)
    return
  }

  console.log('[telegram] starting polling service')
  const model = cfg.telegram?.model
  telegramService = createTelegramService({
    botToken: token,
    model,
    server,
    groupConfig: cfg.telegram?.group,
    botUsername: undefined, // TODO: resolve bot username from Bot API getMe
    groupVerbosity: cfg.groupVerbosity,
    groupCheckIntervalMs: cfg.groupCheckIntervalMs,
    policy: applyChannelsConfigToPolicy(telegramPolicy, cfg)
  })
  telegramService.startPolling()
  console.log('[telegram] polling started')
}

async function applyQQConfig(cfg: ChannelsConfig): Promise<void> {
  const wsUrl = cfg.qq?.wsUrl?.trim()
  const enabled = cfg.qq?.enabled ?? false

  if (qqService) {
    console.log('[qq] stopping existing service')
    const old = qqService
    qqService = null
    try {
      await old.stop()
    } catch (e) {
      console.error('[qq] stop error', e)
    }
  }

  if (!enabled || !wsUrl || !server) {
    console.log(`[qq] service not started (enabled=${enabled}, hasWsUrl=${Boolean(wsUrl)})`)
    return
  }

  console.log('[qq] starting QQ service')
  const model = cfg.qq?.model
  qqService = createQQService({
    wsUrl,
    token: cfg.qq?.token,
    model,
    server,
    groupConfig: cfg.qq?.group,
    botQQId: cfg.qq?.token ? undefined : undefined, // TODO: resolve bot's own QQ ID for @mention detection
    groupVerbosity: cfg.groupVerbosity,
    groupCheckIntervalMs: cfg.groupCheckIntervalMs,
    policy: applyChannelsConfigToPolicy(qqPolicy, cfg)
  })
  qqService.connect()
  console.log('[qq] service started')
}

async function applyDiscordConfig(cfg: ChannelsConfig): Promise<void> {
  const token = cfg.discord?.botToken?.trim()
  const enabled = cfg.discord?.enabled ?? false

  if (discordService) {
    console.log('[discord] stopping existing service')
    const old = discordService
    discordService = null
    try {
      await old.stop()
    } catch (e) {
      console.error('[discord] stop error', e)
    }
  }

  if (!enabled || !token || !server) {
    console.log(`[discord] service not started (enabled=${enabled}, hasToken=${Boolean(token)})`)
    return
  }

  console.log('[discord] starting service')
  const model = cfg.discord?.model
  discordService = createDiscordService({
    botToken: token,
    model,
    server,
    groupConfig: cfg.discord?.group,
    groupVerbosity: cfg.groupVerbosity,
    groupCheckIntervalMs: cfg.groupCheckIntervalMs,
    policy: applyChannelsConfigToPolicy(discordPolicy, cfg)
  })
  discordService.connect()
  console.log('[discord] service started')
}

async function applyQQBotConfig(cfg: ChannelsConfig): Promise<void> {
  const appId = cfg.qqbot?.appId?.trim()
  const clientSecret = cfg.qqbot?.clientSecret?.trim()
  const enabled = cfg.qqbot?.enabled ?? false

  if (qqbotService) {
    console.log('[qqbot] stopping existing service')
    const old = qqbotService
    qqbotService = null
    try {
      await old.stop()
    } catch (e) {
      console.error('[qqbot] stop error', e)
    }
  }

  if (!enabled || !appId || !clientSecret || !server) {
    console.log(
      `[qqbot] service not started (enabled=${enabled}, hasAppId=${Boolean(appId)}, hasSecret=${Boolean(clientSecret)})`
    )
    return
  }

  console.log('[qqbot] starting QQBot service')
  const model = cfg.qqbot?.model
  qqbotService = createQQBotService({
    appId,
    clientSecret,
    model,
    server,
    policy: applyChannelsConfigToPolicy(qqbotPolicy, cfg)
  })
  qqbotService.connect()
  console.log('[qqbot] service started')
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
  const nextServer = createSqliteYachiyoServer({
    dbPath: resolveYachiyoDbPath(),
    settingsPath: resolveYachiyoSettingsPath(),
    developmentMode: is.dev,
    seedPresetProviders: true,
    fetchImpl: (input, init) =>
      net.fetch(input instanceof URL ? input.toString() : (input as string | Request), init),
    webExternalFetchImpl: input.webExternalFetchImpl,
    jotdownStore: input.jotdownStore
  })
  nextServer.subscribe(broadcastYachiyoEvent)
  nextServer.getTtlReaper().start()
  return nextServer
}

async function stopLiveServices(): Promise<void> {
  scheduleService?.stop()
  scheduleService = null

  const activeTelegramService = telegramService
  telegramService = null
  if (activeTelegramService) {
    await activeTelegramService.stop()
  }

  const activeQQService = qqService
  qqService = null
  if (activeQQService) {
    await activeQQService.stop()
  }

  const activeDiscordService = discordService
  discordService = null
  if (activeDiscordService) {
    await activeDiscordService.stop()
  }
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
      sendChat: (input) => server!.sendChat(input as never),
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

  if (!is.dev || process.env['YACHIYO_DEV_CHANNELS']) {
    const channelsConfig = server.getChannelsConfig()
    const channelStarts = [
      { label: 'telegram', start: () => applyTelegramConfig(channelsConfig) },
      { label: 'qq', start: () => applyQQConfig(channelsConfig) },
      { label: 'discord', start: () => applyDiscordConfig(channelsConfig) },
      { label: 'qqbot', start: () => applyQQBotConfig(channelsConfig) }
    ]

    for (const channel of channelStarts) {
      try {
        await channel.start()
      } catch (error) {
        console.error(`[${channel.label}] startup failed:`, error)
      }
    }
  }
}

async function restartServerForDemoModeChange(): Promise<void> {
  const previousServer = server
  await stopLiveServices()
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

  handleYachiyoIpc(IPC_CHANNELS.searchThreadsAndMessages, (input: SearchThreadsAndMessagesInput) =>
    server!.searchThreadsAndMessages(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.searchWorkspaceFiles, (input: SearchWorkspaceFilesInput) =>
    server!.searchWorkspaceFiles(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.listThings, (input?: { includeInactive?: boolean }) =>
    server!.listThings(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.getThing, (input: { name: string }) => server!.getThing(input))
  handleYachiyoIpc(IPC_CHANNELS.reactivateThing, (input: { name: string }) =>
    server!.reactivateThing(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.deleteThing, (input: DeleteThingInput) =>
    server!.deleteThing(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.continueThingInNewChat, (input: { name: string }) =>
    server!.continueThingInNewChat(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.bootstrap, () => server!.bootstrap())
  handleYachiyoIpc(
    IPC_CHANNELS.createThread,
    (input?: {
      workspacePath?: string
      createdFromEssentialId?: string
      privacyMode?: boolean
      enabledTools?: ToolCallName[]
      runMode?: RunModeId
      reasoningEffort?: ComposerReasoningSelection
    }) => server!.createThread(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.createBranch, (input: { threadId: string; messageId: string }) =>
    server!.createBranch(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.compactThreadToAnotherThread, (input: CompactThreadInput) =>
    server!.compactThreadToAnotherThread(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.createFolderForThreads, (input: { threadIds: string[] }) =>
    server!.createFolderForThreads(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.renameFolder, (input: { folderId: string; title: string }) =>
    server!.renameFolder(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.setFolderColor,
    (input: { folderId: string; colorTag: string | null }) => server!.setFolderColor(input as never)
  )
  handleYachiyoIpc(IPC_CHANNELS.deleteFolder, (input: { folderId: string }) =>
    server!.deleteFolder(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.moveThreadToFolder,
    (input: { threadId: string; folderId: string | null }) => server!.moveThreadToFolder(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.renameThread, (input: { threadId: string; title: string }) =>
    server!.renameThread(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.setThreadColor,
    (input: { threadId: string; colorTag: ThreadColorTag | null }) => server!.setThreadColor(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.setThreadIcon, (input: { threadId: string; icon: string | null }) =>
    server!.setThreadIcon(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.showEmojiPanel, () => {
    app.showEmojiPanel()
  })
  handleYachiyoIpc(IPC_CHANNELS.archiveThread, (input: { threadId: string }) =>
    server!.archiveThread(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.deleteThread, (input: { threadId: string }) =>
    server!.deleteThread(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.openThreadWorkspace, (input: { threadId: string }) =>
    server!
      .openThreadWorkspace(input)
      .then((workspacePath) => openThreadWorkspace(input.threadId, workspacePath))
  )
  handleYachiyoIpc(
    IPC_CHANNELS.getThreadWorkspaceChangeDecision,
    (input: { threadId: string; workspacePath?: string | null }) =>
      server!.getThreadWorkspaceChangeDecision(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.readThreadPlanDocument, (input: { threadId: string }) =>
    server!.readThreadPlanDocument(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.acceptThreadPlanDocument, (input: AcceptThreadPlanDocumentInput) =>
    server!.acceptThreadPlanDocument(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.listDiscoveredApps, () => discoverApps())
  handleYachiyoIpc(
    IPC_CHANNELS.openWorkspaceWithApp,
    async (input: { threadId: string; appName: string }) => {
      const workspacePath = await server!.openThreadWorkspace({ threadId: input.threadId })
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
      server!.updateThreadWorkspace(input)
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
  handleYachiyoIpc(IPC_CHANNELS.restoreThread, (input: { threadId: string }) =>
    server!.restoreThread(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.saveToolPreferences, (input: ToolPreferencesInput) =>
    server!.saveToolPreferences(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.clearRecapText, (input: { threadId: string }) =>
    server!.clearRecapText(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.requestRecap, (input: { threadId: string }) =>
    server!.requestRecap(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.sendChat, (input: SendChatInput) => server!.sendChat(input))
  handleYachiyoIpc(IPC_CHANNELS.retryMessage, (input: RetryInput) => server!.retryMessage(input))
  handleYachiyoIpc(IPC_CHANNELS.saveThread, (input: SaveThreadInput) => server!.saveThread(input))
  handleYachiyoIpc(
    IPC_CHANNELS.selectReplyBranch,
    (input: { threadId: string; assistantMessageId: string }) => server!.selectReplyBranch(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.deleteMessage, (input: { threadId: string; messageId: string }) =>
    server!.deleteMessageFromHere(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.editMessage, (input: EditMessageInput) =>
    server!.editMessage(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.cancelRun, (input: { runId: string }) => server!.cancelRun(input))
  handleYachiyoIpc(IPC_CHANNELS.withdrawPendingSteer, (input: { threadId: string }) =>
    server!.withdrawPendingSteer(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.answerToolQuestion, (input: AnswerToolQuestionInput) =>
    server!.answerToolQuestion(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.getConfig, () => server!.getConfig())
  handleYachiyoIpc(IPC_CHANNELS.getSoulDocument, () => server!.getSoulDocument())
  handleYachiyoIpc(IPC_CHANNELS.addSoulTrait, (input: { trait: string }) =>
    server!.addSoulTrait(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.deleteSoulTrait, (input: { trait: string }) =>
    server!.deleteSoulTrait(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.getMemoryTermDocument,
    (input?: GetMemoryTermDocumentInput): Promise<MemoryTermDocument> =>
      server!.getMemoryTermDocument(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.deleteMemoryTerm,
    (input: DeleteMemoryTermInput): Promise<DeleteMemoryTermResult> =>
      server!.deleteMemoryTerm(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.listActivitySourceRecords,
    (input?: ListActivitySourceRecordsInput) => server!.listActivitySourceRecords(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.getUserDocument, () => server!.getUserDocument())
  handleYachiyoIpc(IPC_CHANNELS.testSubagentProfile, (input: TestSubagentProfileInput) =>
    server!.testSubagentProfile(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.getSettings, () => server!.getSettings())
  handleYachiyoIpc(IPC_CHANNELS.saveConfig, async (input: SettingsConfig) => {
    const currentConfig = await server!.getConfig()
    const demoModeBeforeSave = is.dev && currentConfig.general?.demoMode === true
    const configToSave = await resolveActivityTrackingPermission(input, currentConfig)
    const saved = await server!.saveConfig(configToSave)
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
    server!.saveUserDocument(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.saveSettings, (input: Partial<ProviderSettings>) =>
    server!.saveSettings(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.upsertProvider, (input: ProviderConfig) =>
    server!.upsertProvider(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.removeProvider, (input: { name: string }) =>
    server!.removeProvider(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.enableProviderModel, (input: { name: string; model: string }) =>
    server!.enableProviderModel(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.disableProviderModel, (input: { name: string; model: string }) =>
    server!.disableProviderModel(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.fetchProviderModels, (input: ProviderConfig) =>
    server!.fetchProviderModels(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.listWebSearchBrowserImportSources, () =>
    server!.listWebSearchBrowserImportSources()
  )
  handleYachiyoIpc(IPC_CHANNELS.listSkills, (input: ListSkillsInput | undefined) =>
    server!.listSkills(input)
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
    (input: ImportWebSearchBrowserSessionInput) => server!.importWebSearchBrowserSession(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.listBrowserAutomationSessions,
    (input: ListBrowserAutomationSessionsInput): BrowserAutomationSessionRecord[] =>
      server!.listBrowserAutomationSessions(input)
  )
  ipcMain.removeHandler(IPC_CHANNELS.showBrowserAutomationSession)
  ipcMain.handle(
    IPC_CHANNELS.showBrowserAutomationSession,
    (event, input: ShowBrowserAutomationSessionInput): BrowserAutomationSessionRecord => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window || window.isDestroyed()) {
        throw new Error('Unable to show browser session: source window is unavailable.')
      }
      return server!.showBrowserAutomationSession({ ...input, window })
    }
  )
  handleYachiyoIpc(
    IPC_CHANNELS.hideBrowserAutomationSession,
    (input: HideBrowserAutomationSessionInput): void => {
      server!.hideBrowserAutomationSession(input)
    }
  )
  handleYachiyoIpc(
    IPC_CHANNELS.setBrowserAutomationSessionBounds,
    (input: SetBrowserAutomationSessionBoundsInput): BrowserAutomationSessionRecord =>
      server!.setBrowserAutomationSessionBounds(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.setThreadPrivacyMode,
    (input: { threadId: string; enabled: boolean }) => server!.setThreadPrivacyMode(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.setThreadModelOverride,
    (input: { threadId: string; modelOverride: ThreadModelOverride | null }) =>
      server!.setThreadModelOverride(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.setThreadReasoningEffort,
    (input: { threadId: string; reasoningEffort: ComposerReasoningSelection | null }) =>
      server!.setThreadReasoningEffort(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.setThreadToolMode,
    (input: { threadId: string; enabledTools: ToolCallName[]; runMode?: RunModeId }) =>
      server!.setThreadToolMode(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.setThreadRuntimeBinding,
    (input: {
      threadId: string
      runtimeBinding: import('@yachiyo/shared/protocol').ThreadRuntimeBinding | null
    }) => server!.setThreadRuntimeBinding(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.regenerateThreadTitle, (input: { threadId: string }) =>
    server!.regenerateThreadTitle(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.starThread, (input: { threadId: string; starred: boolean }) =>
    server!.starThread(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.loadThreadData,
    (input: { threadId: string; includeMessages?: boolean }) =>
      server!.loadThreadData(input.threadId, { includeMessages: input.includeMessages })
  )
  handleYachiyoIpc(IPC_CHANNELS.listBackgroundTasks, (input?: { threadId?: string }) =>
    server!.listBackgroundTasks(input)
  )
  handleYachiyoIpc(
    IPC_CHANNELS.getBackgroundTaskLog,
    (input: { threadId: string; taskId: string; maxBytes?: number }) =>
      server!.getBackgroundTaskLog(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.cancelBackgroundTask, (input: { taskId: string }) =>
    server!.cancelBackgroundTask(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.listExternalThreads, () => server!.listExternalThreads())
  handleYachiyoIpc(IPC_CHANNELS.listChannelUsers, () => server!.listChannelUsers())
  handleYachiyoIpc(IPC_CHANNELS.updateChannelUser, (input: UpdateChannelUserInput) =>
    server!.updateChannelUser(input)
  )
  handleYachiyoIpc(IPC_CHANNELS.listChannelGroups, () => server!.listChannelGroups())
  handleYachiyoIpc(IPC_CHANNELS.updateChannelGroup, (input: UpdateChannelGroupInput) => {
    const updated = server!.updateChannelGroup(input)
    // Notify running channel services so they can start/stop monitors.
    telegramService?.onGroupStatusChange(updated)
    qqService?.onGroupStatusChange(updated)
    discordService?.onGroupStatusChange(updated)
    return updated
  })
  handleYachiyoIpc(IPC_CHANNELS.clearGroupMonitorBuffer, async (input: { groupId: string }) => {
    server!.startClearChannelGroupHistory(input)
    telegramService?.clearGroupMessages(input.groupId)
    qqService?.clearGroupMessages(input.groupId)
    discordService?.clearGroupMessages(input.groupId)
  })
  handleYachiyoIpc(IPC_CHANNELS.getChannelsConfig, () => server!.getChannelsConfig())
  handleYachiyoIpc(IPC_CHANNELS.saveChannelsConfig, async (input: ChannelsConfig) => {
    const saved = server!.saveChannelsConfig(input)
    await applyTelegramConfig(saved)
    await applyQQConfig(saved)
    await applyDiscordConfig(saved)
    await applyQQBotConfig(saved)
    return saved
  })
  handleYachiyoIpc(
    IPC_CHANNELS.restartChannelService,
    async (input: { platform: 'telegram' | 'qq' | 'discord' | 'qqbot' | 'all' }) => {
      const cfg = server!.getChannelsConfig()
      if (input.platform === 'all') {
        const restarts = [
          { label: 'telegram', start: () => applyTelegramConfig(cfg) },
          { label: 'qq', start: () => applyQQConfig(cfg) },
          { label: 'discord', start: () => applyDiscordConfig(cfg) },
          { label: 'qqbot', start: () => applyQQBotConfig(cfg) }
        ]
        for (const channel of restarts) {
          try {
            await channel.start()
          } catch (error) {
            console.error(`[${channel.label}] restart failed:`, error)
          }
        }
        return
      }
      switch (input.platform) {
        case 'telegram':
          await applyTelegramConfig(cfg)
          break
        case 'qq':
          await applyQQConfig(cfg)
          break
        case 'discord':
          await applyDiscordConfig(cfg)
          break
        case 'qqbot':
          await applyQQBotConfig(cfg)
          break
      }
    }
  )
  // Schedule CRUD
  handleYachiyoIpc(IPC_CHANNELS.listSchedules, () => server!.listSchedules())
  handleYachiyoIpc(IPC_CHANNELS.createSchedule, (input: CreateScheduleInput) => {
    const schedule = server!.createSchedule(input)
    scheduleService?.reload()
    return schedule
  })
  handleYachiyoIpc(IPC_CHANNELS.updateSchedule, (input: UpdateScheduleInput) => {
    const schedule = server!.updateSchedule(input)
    scheduleService?.reload()
    return schedule
  })
  handleYachiyoIpc(IPC_CHANNELS.deleteSchedule, (input: { id: string }) => {
    server!.deleteSchedule(input.id)
    scheduleService?.reload()
  })
  handleYachiyoIpc(IPC_CHANNELS.enableSchedule, (input: { id: string }) => {
    const result = server!.enableSchedule(input.id)
    scheduleService?.reload()
    return result
  })
  handleYachiyoIpc(IPC_CHANNELS.disableSchedule, (input: { id: string }) => {
    const result = server!.disableSchedule(input.id)
    scheduleService?.reload()
    return result
  })
  handleYachiyoIpc(IPC_CHANNELS.listScheduleRuns, (input: { scheduleId: string; limit?: number }) =>
    server!.listScheduleRuns(input.scheduleId, input.limit)
  )
  handleYachiyoIpc(IPC_CHANNELS.listRecentScheduleRuns, (input?: { limit?: number }) =>
    server!.listRecentScheduleRuns(input?.limit)
  )
  handleYachiyoIpc(IPC_CHANNELS.triggerScheduleNow, async (input: { scheduleId: string }) => {
    await scheduleService?.triggerScheduleNow(input.scheduleId)
  })
  handleYachiyoIpc(IPC_CHANNELS.markThreadAsRead, (input: { threadId: string }) =>
    server!.markThreadAsRead(input)
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
      server!.downloadRemoteImageForMessage(input)
  )

  ipcMain.removeHandler(IPC_CHANNELS.translate)
  ipcMain.handle(IPC_CHANNELS.translate, async (event, input: TranslateInput) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return server!.translateStream(input, (delta) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('translator:delta', delta)
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
    server!.pruneEmptyTemporaryWorkspaces()
  )

  handleYachiyoIpc(IPC_CHANNELS.getUsageStats, (input: UsageStatsInput) =>
    server!.getUsageStats(input)
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
    scheduleService?.stop()
    scheduleService = null
    void telegramService?.stop().catch(() => {})
    telegramService = null
    void qqService?.stop().catch(() => {})
    qqService = null
    void discordService?.stop().catch(() => {})
    discordService = null
    void qqbotService?.stop().catch(() => {})
    qqbotService = null
    commandSocketRestartInFlight = null
    void commandSocket?.close()
    commandSocket = null
    void server?.close()
    server = null
  })

  return server
}

export { IPC_CHANNELS }
