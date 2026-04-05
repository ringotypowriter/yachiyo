import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  AnswerToolQuestionInput,
  BootstrapPayload,
  ChannelGroupRecord,
  ChannelsConfig,
  ChannelUserRecord,
  ChatAccepted,
  CompactThreadAccepted,
  CompactThreadInput,
  CreateScheduleInput,
  EditMessageInput,
  GetMemoryTermDocumentInput,
  FileMentionCandidate,
  ImportWebSearchBrowserSessionInput,
  ListSkillsInput,
  ProviderConfig,
  ProviderSettings,
  RetryInput,
  RetryAccepted,
  SaveThreadInput,
  SaveThreadResult,
  ScheduleRecord,
  ScheduleRunRecord,
  SearchWorkspaceFilesInput,
  SettingsConfig,
  SendChatInput,
  TestMemoryConnectionInput,
  TestMemoryConnectionResult,
  TestSubagentProfileInput,
  TestSubagentProfileResult,
  ThreadModelOverride,
  ThreadRuntimeBinding,
  ThreadSearchResult,
  MemoryTermDocument,
  UpdateChannelGroupInput,
  UpdateChannelUserInput,
  UpdateScheduleInput,
  UserDocument,
  SoulDocument,
  ThreadSnapshot,
  ThreadRecord,
  ToolPreferencesInput,
  TranslateInput,
  TranslateResult,
  SkillCatalogEntry,
  WebSearchBrowserImportSource,
  YachiyoServerEvent
} from '../shared/yachiyo/protocol'

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      openSettings: (tab?: string) => void
      openTranslator: () => void
      navigateToArchivedThread: (threadId: string) => void
      onNavigateToArchivedThread: (listener: (threadId: string) => void) => () => void
      setVibrancy: (enabled: boolean) => void
      appUpdate: {
        getStatus: () => Promise<{ state: string; version?: string; error?: string }>
        check: () => void
        download: () => void
        install: () => void
        openRelease: () => void
        setChannel: (channel: 'stable' | 'beta') => void
        onStatus: (
          listener: (status: { state: string; version?: string; error?: string }) => void
        ) => () => void
      }
      yachiyo: {
        searchThreadsAndMessages: (input: { query: string }) => Promise<ThreadSearchResult[]>
        searchWorkspaceFiles: (input: SearchWorkspaceFilesInput) => Promise<FileMentionCandidate[]>
        archiveThread: (input: { threadId: string }) => Promise<void>
        bootstrap: () => Promise<BootstrapPayload>
        createBranch: (input: { threadId: string; messageId: string }) => Promise<ThreadSnapshot>
        compactThreadToAnotherThread: (input: CompactThreadInput) => Promise<CompactThreadAccepted>
        createThread: (input?: {
          workspacePath?: string
          createdFromEssentialId?: string
          privacyMode?: boolean
        }) => Promise<ThreadRecord>
        deleteThread: (input: { threadId: string }) => Promise<void>
        deleteMessage: (input: { threadId: string; messageId: string }) => Promise<ThreadSnapshot>
        editMessage: (input: EditMessageInput) => Promise<ChatAccepted>
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
        answerToolQuestion: (input: AnswerToolQuestionInput) => Promise<void>
        translate: (input: TranslateInput) => Promise<TranslateResult>
        onTranslateDelta: (listener: (delta: string) => void) => () => void
        getConfig: () => Promise<SettingsConfig>
        getSoulDocument: () => Promise<SoulDocument>
        addSoulTrait: (input: { trait: string }) => Promise<SoulDocument>
        deleteSoulTrait: (input: { trait: string }) => Promise<SoulDocument>
        getMemoryTermDocument: (input?: GetMemoryTermDocumentInput) => Promise<MemoryTermDocument>
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
        openSkillsFolder: () => Promise<void>
        listWebSearchBrowserImportSources: () => Promise<WebSearchBrowserImportSource[]>
        importWebSearchBrowserSession: (
          input: ImportWebSearchBrowserSessionInput
        ) => Promise<SettingsConfig>
        setThreadPrivacyMode: (input: {
          threadId: string
          enabled: boolean
        }) => Promise<ThreadRecord>
        setThreadModelOverride: (input: {
          threadId: string
          modelOverride: ThreadModelOverride | null
        }) => Promise<ThreadRecord>
        setThreadRuntimeBinding: (input: {
          threadId: string
          runtimeBinding: ThreadRuntimeBinding | null
        }) => Promise<ThreadRecord>
        regenerateThreadTitle: (input: { threadId: string }) => Promise<ThreadRecord>
        starThread: (input: { threadId: string; starred: boolean }) => Promise<ThreadRecord>
        readClipboardFilePaths: () => Promise<
          { filename: string; mediaType: string; dataUrl: string }[]
        >
        readAttachmentFile: (input: { filePath: string; mediaType: string }) => Promise<string>
        listDiscoveredApps: () => Promise<{
          editors: { name: string; iconDataUrl?: string }[]
          terminals: { name: string; iconDataUrl?: string }[]
        }>
        openWorkspaceWithApp: (input: { threadId: string; appName: string }) => Promise<void>
        loadThreadData: (input: { threadId: string }) => Promise<{
          messages: import('../shared/yachiyo/protocol').MessageRecord[]
          toolCalls: import('../shared/yachiyo/protocol').ToolCallRecord[]
        }>
        listExternalThreads: () => Promise<ThreadRecord[]>
        listChannelUsers: () => Promise<ChannelUserRecord[]>
        updateChannelUser: (input: UpdateChannelUserInput) => Promise<ChannelUserRecord>
        listChannelGroups: () => Promise<ChannelGroupRecord[]>
        updateChannelGroup: (input: UpdateChannelGroupInput) => Promise<ChannelGroupRecord>
        clearGroupMonitorBuffer: (groupId: string) => Promise<void>
        getChannelsConfig: () => Promise<ChannelsConfig>
        saveChannelsConfig: (input: ChannelsConfig) => Promise<ChannelsConfig>

        // Schedules
        listSchedules: () => Promise<ScheduleRecord[]>
        createSchedule: (input: CreateScheduleInput) => Promise<ScheduleRecord>
        updateSchedule: (input: UpdateScheduleInput) => Promise<ScheduleRecord>
        deleteSchedule: (input: { id: string }) => Promise<void>
        enableSchedule: (input: { id: string }) => Promise<boolean>
        disableSchedule: (input: { id: string }) => Promise<ScheduleRecord>
        listScheduleRuns: (input: {
          scheduleId: string
          limit?: number
        }) => Promise<ScheduleRunRecord[]>
        listRecentScheduleRuns: (input?: { limit?: number }) => Promise<ScheduleRunRecord[]>
        markThreadAsRead: (input: { threadId: string }) => Promise<ThreadRecord>

        showNotification: (input: { title: string; body?: string }) => void
        beep: () => void
        subscribe: (listener: (event: YachiyoServerEvent) => void) => () => void
      }
    }
  }
}
