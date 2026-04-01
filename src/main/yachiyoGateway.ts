import { app, BrowserWindow, ipcMain, net, Notification, powerMonitor, session } from 'electron'
import { is } from '@electron-toolkit/utils'
import { spawn } from 'child_process'
import { join } from 'node:path'

import type {
  ChannelsConfig,
  CompactThreadInput,
  CreateScheduleInput,
  EditMessageInput,
  GetMemoryTermDocumentInput,
  SearchWorkspaceFilesInput,
  ImportWebSearchBrowserSessionInput,
  ListSkillsInput,
  ProviderConfig,
  ProviderSettings,
  RetryInput,
  SaveThreadInput,
  SettingsConfig,
  SendChatInput,
  MemoryTermDocument,
  TestMemoryConnectionInput,
  TestSubagentProfileInput,
  ThreadModelOverride,
  ToolPreferencesInput,
  UpdateChannelGroupInput,
  UpdateChannelUserInput,
  UpdateScheduleInput,
  YachiyoServerEvent
} from '../shared/yachiyo/protocol'
import {
  createSqliteYachiyoServer,
  type YachiyoServer
} from './yachiyo-server/app/YachiyoServer.ts'
import {
  resolveYachiyoDataDir,
  resolveYachiyoDbPath,
  resolveYachiyoSettingsPath,
  resolveYachiyoSocketPath,
  resolveYachiyoTempWorkspaceRoot
} from './yachiyo-server/config/paths.ts'
import {
  startCommandSocket,
  type CommandSocketHandle,
  type SendChannelInput
} from './commandSocket.ts'
import { openThreadWorkspace } from './openThreadWorkspace.ts'
import { discoverApps } from './appDiscovery.ts'
import {
  createTelegramService,
  type TelegramService
} from './yachiyo-server/channels/telegramService.ts'
import { createQQService, type QQService } from './yachiyo-server/channels/qqService.ts'
import {
  createDiscordService,
  type DiscordService
} from './yachiyo-server/channels/discordService.ts'
import {
  applyChannelsConfigToPolicy,
  telegramPolicy,
  qqPolicy,
  discordPolicy
} from './yachiyo-server/channels/channelPolicy.ts'
import {
  createScheduleService,
  type ScheduleService
} from './yachiyo-server/services/scheduleService.ts'

const IPC_CHANNELS = {
  showNotification: 'yachiyo:show-notification',
  beep: 'yachiyo:beep',
  archiveThread: 'yachiyo:archive-thread',
  searchWorkspaceFiles: 'yachiyo:search-workspace-files',
  searchThreadsAndMessages: 'yachiyo:search-threads-and-messages',
  deleteThread: 'yachiyo:delete-thread',
  disableProviderModel: 'yachiyo:disable-provider-model',
  fetchProviderModels: 'yachiyo:fetch-provider-models',
  importWebSearchBrowserSession: 'yachiyo:import-web-search-browser-session',
  bootstrap: 'yachiyo:bootstrap',
  cancelRun: 'yachiyo:cancel-run',
  compactThreadToAnotherThread: 'yachiyo:compact-thread-to-another-thread',
  createBranch: 'yachiyo:create-branch',
  createThread: 'yachiyo:create-thread',
  deleteMessage: 'yachiyo:delete-message',
  editMessage: 'yachiyo:edit-message',
  enableProviderModel: 'yachiyo:enable-provider-model',
  event: 'yachiyo:event',
  getConfig: 'yachiyo:get-config',
  getSoulDocument: 'yachiyo:get-soul-document',
  addSoulTrait: 'yachiyo:add-soul-trait',
  deleteSoulTrait: 'yachiyo:delete-soul-trait',
  getMemoryTermDocument: 'yachiyo:get-memory-term-document',
  getUserDocument: 'yachiyo:get-user-document',
  getSettings: 'yachiyo:get-settings',
  renameThread: 'yachiyo:rename-thread',
  setThreadIcon: 'yachiyo:set-thread-icon',
  showEmojiPanel: 'yachiyo:show-emoji-panel',
  removeProvider: 'yachiyo:remove-provider',
  listWebSearchBrowserImportSources: 'yachiyo:list-web-search-browser-import-sources',
  listSkills: 'yachiyo:list-skills',
  openThreadWorkspace: 'yachiyo:open-thread-workspace',
  pickWorkspaceDirectory: 'yachiyo:pick-workspace-directory',
  restoreThread: 'yachiyo:restore-thread',
  retryMessage: 'yachiyo:retry-message',
  saveThread: 'yachiyo:save-thread',
  testMemoryConnection: 'yachiyo:test-memory-connection',
  testSubagentProfile: 'yachiyo:test-subagent-profile',
  saveConfig: 'yachiyo:save-config',
  saveUserDocument: 'yachiyo:save-user-document',
  saveSettings: 'yachiyo:save-settings',
  saveToolPreferences: 'yachiyo:save-tool-preferences',
  selectReplyBranch: 'yachiyo:select-reply-branch',
  sendChat: 'yachiyo:send-chat',
  updateThreadWorkspace: 'yachiyo:update-thread-workspace',
  upsertProvider: 'yachiyo:upsert-provider',
  setThreadPrivacyMode: 'yachiyo:set-thread-privacy-mode',
  setThreadModelOverride: 'yachiyo:set-thread-model-override',
  setThreadRuntimeBinding: 'yachiyo:set-thread-runtime-binding',
  regenerateThreadTitle: 'yachiyo:regenerate-thread-title',
  starThread: 'yachiyo:star-thread',
  readClipboardFilePaths: 'yachiyo:read-clipboard-file-paths',
  readAttachmentFile: 'yachiyo:read-attachment-file',
  listDiscoveredApps: 'yachiyo:list-discovered-apps',
  openWorkspaceWithApp: 'yachiyo:open-workspace-with-app',
  loadThreadData: 'yachiyo:load-thread-data',
  listExternalThreads: 'yachiyo:list-external-threads',
  listChannelUsers: 'yachiyo:list-channel-users',
  updateChannelUser: 'yachiyo:update-channel-user',
  getChannelsConfig: 'yachiyo:get-channels-config',
  saveChannelsConfig: 'yachiyo:save-channels-config',
  listChannelGroups: 'yachiyo:list-channel-groups',
  updateChannelGroup: 'yachiyo:update-channel-group',
  clearGroupMonitorBuffer: 'yachiyo:clear-group-monitor-buffer',
  listSchedules: 'yachiyo:list-schedules',
  createSchedule: 'yachiyo:create-schedule',
  updateSchedule: 'yachiyo:update-schedule',
  deleteSchedule: 'yachiyo:delete-schedule',
  enableSchedule: 'yachiyo:enable-schedule',
  disableSchedule: 'yachiyo:disable-schedule',
  listScheduleRuns: 'yachiyo:list-schedule-runs',
  listRecentScheduleRuns: 'yachiyo:list-recent-schedule-runs',
  markThreadAsRead: 'yachiyo:mark-thread-as-read',
  openSkillsFolder: 'yachiyo:open-skills-folder'
} as const

let server: YachiyoServer | null = null
let telegramService: TelegramService | null = null
let qqService: QQService | null = null
let discordService: DiscordService | null = null
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
    onNotification: (input) => {
      if (!Notification.isSupported()) return
      new Notification({ title: input.title, body: input.body ?? '' }).show()
    },
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

  fatalRunRecoveryRegistered = true
}

function broadcast(event: YachiyoServerEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.event, event)
    }
  }
}

function handle<Args extends unknown[], Result>(
  channel: string,
  listener: (...args: Args) => Result | Promise<Result>
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (_event, ...args: Args) => listener(...args))
}

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
    } else {
      throw new Error(`Unsupported platform: ${platform}`)
    }
    console.log(`[send-channel] sent to ${platform}:${externalId}`)
  })().catch((err) => {
    console.error('[send-channel] failed:', err)
  })
}

export function registerYachiyoGateway(): YachiyoServer {
  if (server) {
    return server
  }

  // net.fetch (used by webRead) runs through the default session. When an
  // SSL-intercepting proxy is in use, disable strict certificate verification
  // so the proxy's re-signed certificates are accepted.
  session.defaultSession.setCertificateVerifyProc((_request, callback) => callback(0))

  // Route global fetch through Electron's net module so libraries using the
  // global fetch (e.g. discord.js) benefit from the proxy/SSL bypass.
  // Note: Telegraf uses node-fetch internally and needs its own proxy agent.
  globalThis.fetch = (input, init?) =>
    net.fetch(input instanceof URL ? input.toString() : (input as string | Request), init)

  server = createSqliteYachiyoServer({
    dbPath: resolveYachiyoDbPath(),
    settingsPath: resolveYachiyoSettingsPath(),
    fetchImpl: (input, init) =>
      net.fetch(input instanceof URL ? input.toString() : (input as string | Request), init)
  })
  registerFatalRunRecovery()
  server.subscribe(broadcast)
  server.getTtlReaper().start()

  // Start channel services if already configured.
  // In dev mode, channels are skipped by default to avoid unintended outbound
  // connections. Set YACHIYO_DEV_CHANNELS=1 (or run `pnpm dev:channels`) to opt in.
  if (!is.dev || process.env['YACHIYO_DEV_CHANNELS']) {
    const channelsConfig = server.getChannelsConfig()
    void applyTelegramConfig(channelsConfig)
    void applyQQConfig(channelsConfig)
    void applyDiscordConfig(channelsConfig)
  }

  // Start schedule service
  scheduleService?.stop()
  scheduleService = createScheduleService({
    server: {
      createThread: (input) => server!.createThread(input),
      setThreadModelOverride: (input) => server!.setThreadModelOverride(input),
      setThreadIcon: (input) => server!.setThreadIcon(input),
      sendChat: (input) => server!.sendChat(input as never),
      archiveThread: (input) => server!.archiveThread(input),
      showNotification: (input) => {
        if (!Notification.isSupported()) return
        new Notification({ title: input.title, body: input.body ?? '' }).show()
      },
      subscribe: (listener) => server!.subscribe(listener)
    },
    storage: server.getStorage(),
    createId: () => server!.generateId(),
    timestamp: () => new Date().toISOString(),
    tempWorkspaceDir: resolveYachiyoTempWorkspaceRoot()
  })
  scheduleService.start()

  ipcMain.removeAllListeners(IPC_CHANNELS.showNotification)
  ipcMain.on(IPC_CHANNELS.showNotification, (_event, input: { title: string; body?: string }) => {
    if (!Notification.isSupported()) return
    new Notification({ title: input.title, body: input.body ?? '' }).show()
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

  handle(IPC_CHANNELS.searchThreadsAndMessages, (input: { query: string }) =>
    server!.searchThreadsAndMessages(input)
  )
  handle(IPC_CHANNELS.searchWorkspaceFiles, (input: SearchWorkspaceFilesInput) =>
    server!.searchWorkspaceFiles(input)
  )
  handle(IPC_CHANNELS.bootstrap, () => server!.bootstrap())
  handle(
    IPC_CHANNELS.createThread,
    (input?: { workspacePath?: string; createdFromEssentialId?: string; privacyMode?: boolean }) =>
      server!.createThread(input)
  )
  handle(IPC_CHANNELS.createBranch, (input: { threadId: string; messageId: string }) =>
    server!.createBranch(input)
  )
  handle(IPC_CHANNELS.compactThreadToAnotherThread, (input: CompactThreadInput) =>
    server!.compactThreadToAnotherThread(input)
  )
  handle(IPC_CHANNELS.renameThread, (input: { threadId: string; title: string }) =>
    server!.renameThread(input)
  )
  handle(IPC_CHANNELS.setThreadIcon, (input: { threadId: string; icon: string | null }) =>
    server!.setThreadIcon(input)
  )
  handle(IPC_CHANNELS.showEmojiPanel, () => {
    app.showEmojiPanel()
  })
  handle(IPC_CHANNELS.archiveThread, (input: { threadId: string }) => server!.archiveThread(input))
  handle(IPC_CHANNELS.deleteThread, (input: { threadId: string }) => server!.deleteThread(input))
  handle(IPC_CHANNELS.openThreadWorkspace, (input: { threadId: string }) =>
    server!
      .openThreadWorkspace(input)
      .then((workspacePath) => openThreadWorkspace(input.threadId, workspacePath))
  )
  handle(IPC_CHANNELS.listDiscoveredApps, () => discoverApps())
  handle(
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
  handle(
    IPC_CHANNELS.updateThreadWorkspace,
    (input: { threadId: string; workspacePath?: string | null }) =>
      server!.updateThreadWorkspace(input)
  )
  handle(IPC_CHANNELS.pickWorkspaceDirectory, async () => {
    const { dialog } = await import('electron')
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Select workspace'
    })

    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle(IPC_CHANNELS.restoreThread, (input: { threadId: string }) => server!.restoreThread(input))
  handle(IPC_CHANNELS.saveToolPreferences, (input: ToolPreferencesInput) =>
    server!.saveToolPreferences(input)
  )
  handle(IPC_CHANNELS.sendChat, (input: SendChatInput) => server!.sendChat(input))
  handle(IPC_CHANNELS.retryMessage, (input: RetryInput) => server!.retryMessage(input))
  handle(IPC_CHANNELS.saveThread, (input: SaveThreadInput) => server!.saveThread(input))
  handle(
    IPC_CHANNELS.selectReplyBranch,
    (input: { threadId: string; assistantMessageId: string }) => server!.selectReplyBranch(input)
  )
  handle(IPC_CHANNELS.deleteMessage, (input: { threadId: string; messageId: string }) =>
    server!.deleteMessageFromHere(input)
  )
  handle(IPC_CHANNELS.editMessage, (input: EditMessageInput) => server!.editMessage(input))
  handle(IPC_CHANNELS.cancelRun, (input: { runId: string }) => server!.cancelRun(input))
  handle(IPC_CHANNELS.getConfig, () => server!.getConfig())
  handle(IPC_CHANNELS.getSoulDocument, () => server!.getSoulDocument())
  handle(IPC_CHANNELS.addSoulTrait, (input: { trait: string }) => server!.addSoulTrait(input))
  handle(IPC_CHANNELS.deleteSoulTrait, (input: { trait: string }) => server!.deleteSoulTrait(input))
  handle(
    IPC_CHANNELS.getMemoryTermDocument,
    (input?: GetMemoryTermDocumentInput): Promise<MemoryTermDocument> =>
      server!.getMemoryTermDocument(input)
  )
  handle(IPC_CHANNELS.getUserDocument, () => server!.getUserDocument())
  handle(IPC_CHANNELS.testMemoryConnection, (input: TestMemoryConnectionInput) =>
    server!.testMemoryConnection(input.config)
  )
  handle(IPC_CHANNELS.testSubagentProfile, (input: TestSubagentProfileInput) =>
    server!.testSubagentProfile(input)
  )
  handle(IPC_CHANNELS.getSettings, () => server!.getSettings())
  handle(IPC_CHANNELS.saveConfig, (input: SettingsConfig) => server!.saveConfig(input))
  handle(IPC_CHANNELS.saveUserDocument, (input: { content: string }) =>
    server!.saveUserDocument(input)
  )
  handle(IPC_CHANNELS.saveSettings, (input: Partial<ProviderSettings>) =>
    server!.saveSettings(input)
  )
  handle(IPC_CHANNELS.upsertProvider, (input: ProviderConfig) => server!.upsertProvider(input))
  handle(IPC_CHANNELS.removeProvider, (input: { name: string }) => server!.removeProvider(input))
  handle(IPC_CHANNELS.enableProviderModel, (input: { name: string; model: string }) =>
    server!.enableProviderModel(input)
  )
  handle(IPC_CHANNELS.disableProviderModel, (input: { name: string; model: string }) =>
    server!.disableProviderModel(input)
  )
  handle(IPC_CHANNELS.fetchProviderModels, (input: ProviderConfig) =>
    server!.fetchProviderModels(input)
  )
  handle(IPC_CHANNELS.listWebSearchBrowserImportSources, () =>
    server!.listWebSearchBrowserImportSources()
  )
  handle(IPC_CHANNELS.listSkills, (input: ListSkillsInput | undefined) => server!.listSkills(input))
  handle(IPC_CHANNELS.openSkillsFolder, async () => {
    const { shell } = await import('electron')
    const { mkdir } = await import('node:fs/promises')
    const skillsDir = join(resolveYachiyoDataDir(), 'skills')
    await mkdir(skillsDir, { recursive: true })
    await shell.openPath(skillsDir)
  })
  handle(IPC_CHANNELS.importWebSearchBrowserSession, (input: ImportWebSearchBrowserSessionInput) =>
    server!.importWebSearchBrowserSession(input)
  )
  handle(IPC_CHANNELS.setThreadPrivacyMode, (input: { threadId: string; enabled: boolean }) =>
    server!.setThreadPrivacyMode(input)
  )
  handle(
    IPC_CHANNELS.setThreadModelOverride,
    (input: { threadId: string; modelOverride: ThreadModelOverride | null }) =>
      server!.setThreadModelOverride(input)
  )
  handle(
    IPC_CHANNELS.setThreadRuntimeBinding,
    (input: {
      threadId: string
      runtimeBinding: import('../shared/yachiyo/protocol').ThreadRuntimeBinding | null
    }) => server!.setThreadRuntimeBinding(input)
  )
  handle(IPC_CHANNELS.regenerateThreadTitle, (input: { threadId: string }) =>
    server!.regenerateThreadTitle(input)
  )
  handle(IPC_CHANNELS.starThread, (input: { threadId: string; starred: boolean }) =>
    server!.starThread(input)
  )
  handle(IPC_CHANNELS.loadThreadData, (input: { threadId: string }) =>
    server!.loadThreadData(input.threadId)
  )
  handle(IPC_CHANNELS.listExternalThreads, () => server!.listExternalThreads())
  handle(IPC_CHANNELS.listChannelUsers, () => server!.listChannelUsers())
  handle(IPC_CHANNELS.updateChannelUser, (input: UpdateChannelUserInput) =>
    server!.updateChannelUser(input)
  )
  handle(IPC_CHANNELS.listChannelGroups, () => server!.listChannelGroups())
  handle(IPC_CHANNELS.updateChannelGroup, (input: UpdateChannelGroupInput) => {
    const updated = server!.updateChannelGroup(input)
    // Notify running channel services so they can start/stop monitors.
    telegramService?.onGroupStatusChange(updated)
    qqService?.onGroupStatusChange(updated)
    discordService?.onGroupStatusChange(updated)
    return updated
  })
  handle(IPC_CHANNELS.clearGroupMonitorBuffer, (input: { groupId: string }) => {
    server!.getStorage().deleteGroupMonitorBuffer(input.groupId)
  })
  handle(IPC_CHANNELS.getChannelsConfig, () => server!.getChannelsConfig())
  handle(IPC_CHANNELS.saveChannelsConfig, async (input: ChannelsConfig) => {
    const saved = server!.saveChannelsConfig(input)
    await applyTelegramConfig(saved)
    await applyQQConfig(saved)
    await applyDiscordConfig(saved)
    return saved
  })
  // Schedule CRUD
  handle(IPC_CHANNELS.listSchedules, () => server!.listSchedules())
  handle(IPC_CHANNELS.createSchedule, (input: CreateScheduleInput) => {
    const schedule = server!.createSchedule(input)
    scheduleService?.reload()
    return schedule
  })
  handle(IPC_CHANNELS.updateSchedule, (input: UpdateScheduleInput) => {
    const schedule = server!.updateSchedule(input)
    scheduleService?.reload()
    return schedule
  })
  handle(IPC_CHANNELS.deleteSchedule, (input: { id: string }) => {
    server!.deleteSchedule(input.id)
    scheduleService?.reload()
  })
  handle(IPC_CHANNELS.enableSchedule, (input: { id: string }) => {
    const result = server!.enableSchedule(input.id)
    scheduleService?.reload()
    return result
  })
  handle(IPC_CHANNELS.disableSchedule, (input: { id: string }) => {
    const result = server!.disableSchedule(input.id)
    scheduleService?.reload()
    return result
  })
  handle(IPC_CHANNELS.listScheduleRuns, (input: { scheduleId: string; limit?: number }) =>
    server!.listScheduleRuns(input.scheduleId, input.limit)
  )
  handle(IPC_CHANNELS.listRecentScheduleRuns, (input?: { limit?: number }) =>
    server!.listRecentScheduleRuns(input?.limit)
  )
  handle(IPC_CHANNELS.markThreadAsRead, (input: { threadId: string }) =>
    server!.markThreadAsRead(input)
  )

  handle(IPC_CHANNELS.readClipboardFilePaths, async () => {
    const { clipboard } = await import('electron')
    const { readFile } = await import('node:fs/promises')
    const { basename, extname } = await import('node:path')

    const ACCEPTED_EXTENSIONS: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.doc': 'application/msword',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.xls': 'application/vnd.ms-excel',
      '.txt': 'text/plain',
      '.csv': 'text/csv',
      '.md': 'text/markdown',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp'
    }

    // readFilePaths is macOS-only and not available in every Electron build
    const readFn = (clipboard as unknown as { readFilePaths?: () => string[] }).readFilePaths
    const paths: string[] = typeof readFn === 'function' ? readFn.call(clipboard) : []
    const results: { filename: string; mediaType: string; dataUrl: string }[] = []

    for (const filePath of paths) {
      const ext = extname(filePath).toLowerCase()
      const mediaType = ACCEPTED_EXTENSIONS[ext]
      if (!mediaType) continue

      const data = await readFile(filePath)
      const base64 = data.toString('base64')
      results.push({
        filename: basename(filePath),
        mediaType,
        dataUrl: `data:${mediaType};base64,${base64}`
      })
    }

    return results
  })

  handle(
    IPC_CHANNELS.readAttachmentFile,
    async (input: { filePath: string; mediaType: string }) => {
      const { readFile } = await import('node:fs/promises')
      const data = await readFile(input.filePath)
      const base64 = data.toString('base64')
      return `data:${input.mediaType};base64,${base64}`
    }
  )

  app.once('before-quit', () => {
    if (commandSocketHealthTimer) {
      clearInterval(commandSocketHealthTimer)
      commandSocketHealthTimer = null
    }
    void telegramService?.stop().catch(() => {})
    telegramService = null
    void qqService?.stop().catch(() => {})
    qqService = null
    void discordService?.stop().catch(() => {})
    discordService = null
    commandSocketRestartInFlight = null
    void commandSocket?.close()
    commandSocket = null
    void server?.close()
    server = null
  })

  return server
}

export { IPC_CHANNELS }
