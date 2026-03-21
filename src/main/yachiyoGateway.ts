import { app, BrowserWindow, ipcMain } from 'electron'

import type {
  ImportWebSearchBrowserSessionInput,
  ProviderConfig,
  ProviderSettings,
  RetryInput,
  SettingsConfig,
  SendChatInput,
  ToolPreferencesInput,
  YachiyoServerEvent
} from '../shared/yachiyo/protocol'
import {
  createSqliteYachiyoServer,
  type YachiyoServer
} from './yachiyo-server/app/YachiyoServer.ts'
import { resolveYachiyoDbPath, resolveYachiyoSettingsPath } from './yachiyo-server/config/paths.ts'
import { openThreadWorkspace } from './openThreadWorkspace.ts'

const IPC_CHANNELS = {
  archiveThread: 'yachiyo:archive-thread',
  disableProviderModel: 'yachiyo:disable-provider-model',
  fetchProviderModels: 'yachiyo:fetch-provider-models',
  importWebSearchBrowserSession: 'yachiyo:import-web-search-browser-session',
  bootstrap: 'yachiyo:bootstrap',
  cancelRun: 'yachiyo:cancel-run',
  createBranch: 'yachiyo:create-branch',
  createThread: 'yachiyo:create-thread',
  deleteMessage: 'yachiyo:delete-message',
  enableProviderModel: 'yachiyo:enable-provider-model',
  event: 'yachiyo:event',
  getConfig: 'yachiyo:get-config',
  getSettings: 'yachiyo:get-settings',
  renameThread: 'yachiyo:rename-thread',
  removeProvider: 'yachiyo:remove-provider',
  listWebSearchBrowserImportSources: 'yachiyo:list-web-search-browser-import-sources',
  openThreadWorkspace: 'yachiyo:open-thread-workspace',
  retryMessage: 'yachiyo:retry-message',
  saveConfig: 'yachiyo:save-config',
  saveSettings: 'yachiyo:save-settings',
  saveToolPreferences: 'yachiyo:save-tool-preferences',
  selectReplyBranch: 'yachiyo:select-reply-branch',
  sendChat: 'yachiyo:send-chat',
  upsertProvider: 'yachiyo:upsert-provider'
} as const

let server: YachiyoServer | null = null
let fatalRunRecoveryRegistered = false

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

  server = createSqliteYachiyoServer({
    dbPath: resolveYachiyoDbPath(),
    settingsPath: resolveYachiyoSettingsPath()
  })
  registerFatalRunRecovery()
  server.subscribe(broadcast)

  handle(IPC_CHANNELS.bootstrap, () => server!.bootstrap())
  handle(IPC_CHANNELS.createThread, () => server!.createThread())
  handle(IPC_CHANNELS.createBranch, (input: { threadId: string; messageId: string }) =>
    server!.createBranch(input)
  )
  handle(IPC_CHANNELS.renameThread, (input: { threadId: string; title: string }) =>
    server!.renameThread(input)
  )
  handle(IPC_CHANNELS.archiveThread, (input: { threadId: string }) => server!.archiveThread(input))
  handle(IPC_CHANNELS.openThreadWorkspace, (input: { threadId: string }) =>
    openThreadWorkspace(input.threadId)
  )
  handle(IPC_CHANNELS.saveToolPreferences, (input: ToolPreferencesInput) =>
    server!.saveToolPreferences(input)
  )
  handle(IPC_CHANNELS.sendChat, (input: SendChatInput) => server!.sendChat(input))
  handle(IPC_CHANNELS.retryMessage, (input: RetryInput) => server!.retryMessage(input))
  handle(
    IPC_CHANNELS.selectReplyBranch,
    (input: { threadId: string; assistantMessageId: string }) => server!.selectReplyBranch(input)
  )
  handle(IPC_CHANNELS.deleteMessage, (input: { threadId: string; messageId: string }) =>
    server!.deleteMessageFromHere(input)
  )
  handle(IPC_CHANNELS.cancelRun, (input: { runId: string }) => server!.cancelRun(input))
  handle(IPC_CHANNELS.getConfig, () => server!.getConfig())
  handle(IPC_CHANNELS.getSettings, () => server!.getSettings())
  handle(IPC_CHANNELS.saveConfig, (input: SettingsConfig) => server!.saveConfig(input))
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
  handle(IPC_CHANNELS.importWebSearchBrowserSession, (input: ImportWebSearchBrowserSessionInput) =>
    server!.importWebSearchBrowserSession(input)
  )

  app.once('before-quit', () => {
    void server?.close()
    server = null
  })

  return server
}

export { IPC_CHANNELS }
