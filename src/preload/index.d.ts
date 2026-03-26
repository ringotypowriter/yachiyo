import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  BootstrapPayload,
  ChatAccepted,
  CompactThreadAccepted,
  CompactThreadInput,
  FileMentionCandidate,
  ImportWebSearchBrowserSessionInput,
  ListSkillsInput,
  ProviderConfig,
  ProviderSettings,
  RetryInput,
  RetryAccepted,
  SaveThreadInput,
  SaveThreadResult,
  SearchWorkspaceFilesInput,
  SettingsConfig,
  SendChatInput,
  TestMemoryConnectionInput,
  TestMemoryConnectionResult,
  TestSubagentProfileInput,
  TestSubagentProfileResult,
  ThreadSearchResult,
  UserDocument,
  ThreadSnapshot,
  ThreadRecord,
  ToolPreferencesInput,
  SkillCatalogEntry,
  WebSearchBrowserImportSource,
  YachiyoServerEvent
} from '../shared/yachiyo/protocol'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      openSettings: () => void
      setVibrancy: (enabled: boolean) => void
      yachiyo: {
        searchThreadsAndMessages: (input: { query: string }) => Promise<ThreadSearchResult[]>
        searchWorkspaceFiles: (input: SearchWorkspaceFilesInput) => Promise<FileMentionCandidate[]>
        archiveThread: (input: { threadId: string }) => Promise<void>
        bootstrap: () => Promise<BootstrapPayload>
        createBranch: (input: { threadId: string; messageId: string }) => Promise<ThreadSnapshot>
        compactThreadToAnotherThread: (input: CompactThreadInput) => Promise<CompactThreadAccepted>
        createThread: (input?: { workspacePath?: string }) => Promise<ThreadRecord>
        deleteThread: (input: { threadId: string }) => Promise<void>
        deleteMessage: (input: { threadId: string; messageId: string }) => Promise<ThreadSnapshot>
        openThreadWorkspace: (input: { threadId: string }) => Promise<void>
        pickWorkspaceDirectory: () => Promise<string | null>
        renameThread: (input: { threadId: string; title: string }) => Promise<ThreadRecord>
        setThreadIcon: (input: { threadId: string; icon: string | null }) => Promise<ThreadRecord>
        showEmojiPanel: () => Promise<void>
        restoreThread: (input: { threadId: string }) => Promise<ThreadRecord>
        saveToolPreferences: (input: ToolPreferencesInput) => Promise<SettingsConfig>
        sendChat: (input: SendChatInput) => Promise<ChatAccepted>
        retryMessage: (input: RetryInput) => Promise<RetryAccepted>
        saveThread: (input: SaveThreadInput) => Promise<SaveThreadResult>
        updateThreadWorkspace: (input: {
          threadId: string
          workspacePath?: string | null
        }) => Promise<ThreadRecord>
        selectReplyBranch: (input: {
          threadId: string
          assistantMessageId: string
        }) => Promise<ThreadRecord>
        cancelRun: (input: { runId: string }) => Promise<void>
        getConfig: () => Promise<SettingsConfig>
        getUserDocument: () => Promise<UserDocument>
        testMemoryConnection: (
          input: TestMemoryConnectionInput
        ) => Promise<TestMemoryConnectionResult>
        testSubagentProfile: (input: TestSubagentProfileInput) => Promise<TestSubagentProfileResult>
        getSettings: () => Promise<ProviderSettings>
        saveConfig: (input: SettingsConfig) => Promise<SettingsConfig>
        saveUserDocument: (input: { content: string }) => Promise<UserDocument>
        saveSettings: (input: Partial<ProviderSettings>) => Promise<ProviderSettings>
        upsertProvider: (input: ProviderConfig) => Promise<ProviderConfig>
        removeProvider: (input: { name: string }) => Promise<SettingsConfig>
        enableProviderModel: (input: { name: string; model: string }) => Promise<SettingsConfig>
        disableProviderModel: (input: { name: string; model: string }) => Promise<SettingsConfig>
        fetchProviderModels: (input: ProviderConfig) => Promise<string[]>
        listSkills: (input?: ListSkillsInput) => Promise<SkillCatalogEntry[]>
        listWebSearchBrowserImportSources: () => Promise<WebSearchBrowserImportSource[]>
        importWebSearchBrowserSession: (
          input: ImportWebSearchBrowserSessionInput
        ) => Promise<SettingsConfig>
        setThreadPrivacyMode: (input: {
          threadId: string
          enabled: boolean
        }) => Promise<ThreadRecord>
        regenerateThreadTitle: (input: { threadId: string }) => Promise<ThreadRecord>
        starThread: (input: { threadId: string; starred: boolean }) => Promise<ThreadRecord>
        readClipboardFilePaths: () => Promise<
          { filename: string; mediaType: string; dataUrl: string }[]
        >
        showNotification: (input: { title: string; body?: string }) => void
        subscribe: (listener: (event: YachiyoServerEvent) => void) => () => void
      }
    }
  }
}
