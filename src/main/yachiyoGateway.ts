import { app, BrowserWindow, ipcMain, net, Notification, session } from 'electron'
import { spawn } from 'child_process'

import type {
  ChannelsConfig,
  CompactThreadInput,
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
  UpdateChannelUserInput,
  YachiyoServerEvent
} from '../shared/yachiyo/protocol'
import {
  createSqliteYachiyoServer,
  type YachiyoServer
} from './yachiyo-server/app/YachiyoServer.ts'
import { resolveYachiyoDbPath, resolveYachiyoSettingsPath } from './yachiyo-server/config/paths.ts'
import { openThreadWorkspace } from './openThreadWorkspace.ts'
import { discoverApps } from './appDiscovery.ts'
import {
  createTelegramService,
  type TelegramService
} from './yachiyo-server/channels/telegramService.ts'
import { createQQService, type QQService } from './yachiyo-server/channels/qqService.ts'

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
  saveChannelsConfig: 'yachiyo:save-channels-config'
} as const

let server: YachiyoServer | null = null
let telegramService: TelegramService | null = null
let qqService: QQService | null = null
let fatalRunRecoveryRegistered = false

function applyTelegramConfig(cfg: ChannelsConfig): void {
  const token = cfg.telegram?.botToken?.trim()
  const enabled = cfg.telegram?.enabled ?? false

  if (telegramService) {
    console.log('[telegram] stopping existing service')
    void telegramService.stop().catch((e) => console.error('[telegram] stop error', e))
    telegramService = null
  }

  if (!enabled || !token || !server) {
    console.log(`[telegram] service not started (enabled=${enabled}, hasToken=${Boolean(token)})`)
    return
  }

  console.log('[telegram] starting polling service')
  const model = cfg.telegram?.model
  telegramService = createTelegramService({ botToken: token, model, server })
  telegramService.startPolling()
  console.log('[telegram] polling started')
}

function applyQQConfig(cfg: ChannelsConfig): void {
  const wsUrl = cfg.qq?.wsUrl?.trim()
  const enabled = cfg.qq?.enabled ?? false

  if (qqService) {
    console.log('[qq] stopping existing service')
    void qqService.stop().catch((e) => console.error('[qq] stop error', e))
    qqService = null
  }

  if (!enabled || !wsUrl || !server) {
    console.log(`[qq] service not started (enabled=${enabled}, hasWsUrl=${Boolean(wsUrl)})`)
    return
  }

  console.log('[qq] starting QQ service')
  const model = cfg.qq?.model
  qqService = createQQService({ wsUrl, token: cfg.qq?.token, model, server })
  qqService.connect()
  console.log('[qq] service started')
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

export function registerYachiyoGateway(): YachiyoServer {
  if (server) {
    return server
  }

  // net.fetch (used by webRead) runs through the default session. When an
  // SSL-intercepting proxy is in use, disable strict certificate verification
  // so the proxy's re-signed certificates are accepted.
  session.defaultSession.setCertificateVerifyProc((_request, callback) => callback(0))

  // Route global fetch through Electron's net module so third-party libraries
  // (e.g. the Telegram Chat SDK adapter) also benefit from the proxy/SSL bypass.
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

  // Start channel services if already configured.
  const channelsConfig = server.getChannelsConfig()
  applyTelegramConfig(channelsConfig)
  applyQQConfig(channelsConfig)

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

  handle(IPC_CHANNELS.searchThreadsAndMessages, (input: { query: string }) =>
    server!.searchThreadsAndMessages(input)
  )
  handle(IPC_CHANNELS.searchWorkspaceFiles, (input: SearchWorkspaceFilesInput) =>
    server!.searchWorkspaceFiles(input)
  )
  handle(IPC_CHANNELS.bootstrap, () => server!.bootstrap())
  handle(IPC_CHANNELS.createThread, (input?: { workspacePath?: string }) =>
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
  handle(IPC_CHANNELS.getChannelsConfig, () => server!.getChannelsConfig())
  handle(IPC_CHANNELS.saveChannelsConfig, (input: ChannelsConfig) => {
    const saved = server!.saveChannelsConfig(input)
    applyTelegramConfig(saved)
    applyQQConfig(saved)
    return saved
  })
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

    // readFilePaths is macOS-only and may be missing from older type stubs
    const paths: string[] = (clipboard as unknown as { readFilePaths(): string[] }).readFilePaths()
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
    void telegramService?.stop().catch(() => {})
    telegramService = null
    void qqService?.stop().catch(() => {})
    qqService = null
    void server?.close()
    server = null
  })

  return server
}

export { IPC_CHANNELS }
