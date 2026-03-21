import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  BootstrapPayload,
  ChatAccepted,
  ImportWebSearchBrowserSessionInput,
  ProviderConfig,
  ProviderSettings,
  RetryInput,
  RetryAccepted,
  SettingsConfig,
  SendChatInput,
  ThreadSnapshot,
  ThreadRecord,
  ToolPreferencesInput,
  WebSearchBrowserImportSource,
  YachiyoServerEvent
} from '../shared/yachiyo/protocol'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      openSettings: () => void
      yachiyo: {
        archiveThread: (input: { threadId: string }) => Promise<void>
        bootstrap: () => Promise<BootstrapPayload>
        createBranch: (input: { threadId: string; messageId: string }) => Promise<ThreadSnapshot>
        createThread: () => Promise<ThreadRecord>
        deleteThread: (input: { threadId: string }) => Promise<void>
        deleteMessage: (input: { threadId: string; messageId: string }) => Promise<ThreadSnapshot>
        openThreadWorkspace: (input: { threadId: string }) => Promise<void>
        renameThread: (input: { threadId: string; title: string }) => Promise<ThreadRecord>
        restoreThread: (input: { threadId: string }) => Promise<ThreadRecord>
        saveToolPreferences: (input: ToolPreferencesInput) => Promise<SettingsConfig>
        sendChat: (input: SendChatInput) => Promise<ChatAccepted>
        retryMessage: (input: RetryInput) => Promise<RetryAccepted>
        selectReplyBranch: (input: {
          threadId: string
          assistantMessageId: string
        }) => Promise<ThreadRecord>
        cancelRun: (input: { runId: string }) => Promise<void>
        getConfig: () => Promise<SettingsConfig>
        getSettings: () => Promise<ProviderSettings>
        saveConfig: (input: SettingsConfig) => Promise<SettingsConfig>
        saveSettings: (input: Partial<ProviderSettings>) => Promise<ProviderSettings>
        upsertProvider: (input: ProviderConfig) => Promise<ProviderConfig>
        removeProvider: (input: { name: string }) => Promise<SettingsConfig>
        enableProviderModel: (input: { name: string; model: string }) => Promise<SettingsConfig>
        disableProviderModel: (input: { name: string; model: string }) => Promise<SettingsConfig>
        fetchProviderModels: (input: ProviderConfig) => Promise<string[]>
        listWebSearchBrowserImportSources: () => Promise<WebSearchBrowserImportSource[]>
        importWebSearchBrowserSession: (
          input: ImportWebSearchBrowserSessionInput
        ) => Promise<SettingsConfig>
        subscribe: (listener: (event: YachiyoServerEvent) => void) => () => void
      }
    }
  }
}
