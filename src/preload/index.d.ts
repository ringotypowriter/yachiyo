import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  BootstrapPayload,
  ChatAccepted,
  ProviderConfig,
  ProviderSettings,
  SettingsConfig,
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
        createThread: () => Promise<ThreadRecord>
        renameThread: (input: { threadId: string; title: string }) => Promise<ThreadRecord>
        sendChat: (input: { threadId: string; content: string }) => Promise<ChatAccepted>
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
