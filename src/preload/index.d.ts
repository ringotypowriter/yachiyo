import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  BootstrapPayload,
  ChatAccepted,
  ProviderConfig,
  ProviderSettings,
  RetryAccepted,
  SettingsConfig,
  ThreadSnapshot,
  ThreadRecord,
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
        deleteMessage: (input: { threadId: string; messageId: string }) => Promise<ThreadSnapshot>
        renameThread: (input: { threadId: string; title: string }) => Promise<ThreadRecord>
        sendChat: (input: { threadId: string; content: string }) => Promise<ChatAccepted>
        retryMessage: (input: {
          threadId: string
          assistantMessageId: string
        }) => Promise<RetryAccepted>
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
        subscribe: (listener: (event: YachiyoServerEvent) => void) => () => void
      }
    }
  }
}
