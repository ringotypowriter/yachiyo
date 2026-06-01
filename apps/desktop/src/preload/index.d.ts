import type {
  AnswerToolQuestionInput,
  BootstrapPayload,
  BrowserAutomationSessionRecord,
  ChannelGroupRecord,
  ChannelsConfig,
  ChannelUserRecord,
  ChatAccepted,
  CompactThreadAccepted,
  CompactThreadInput,
  ComposerReasoningSelection,
  CreateScheduleInput,
  DeleteMemoryTermInput,
  DeleteMemoryTermResult,
  EditMessageInput,
  FolderRecord,
  GetMemoryTermDocumentInput,
  FileMentionCandidate,
  HideBrowserAutomationSessionInput,
  ImportWebSearchBrowserSessionInput,
  ListBrowserAutomationSessionsInput,
  ListActivitySourceRecordsInput,
  ListActivitySourceRecordsResult,
  ListSkillsInput,
  ProviderConfig,
  ProviderSettings,
  RetryInput,
  RetryAccepted,
  ResolveFileReferencesInput,
  ResolvedFileReference,
  SaveThreadInput,
  SetBrowserAutomationSessionBoundsInput,
  SaveThreadResult,
  ReadThreadPlanDocumentInput,
  ReadThreadPlanDocumentResult,
  AcceptThreadPlanDocumentInput,
  ScheduleRecord,
  ScheduleRunRecord,
  SearchWorkspaceFilesInput,
  SettingsConfig,
  SendChatInput,
  ShowBrowserAutomationSessionInput,
  ShowNotificationInput,
  TestSubagentProfileInput,
  TestSubagentProfileResult,
  ThreadColorTag,
  ThreadModelOverride,
  ThreadRuntimeBinding,
  SearchThreadsAndMessagesInput,
  ThreadSearchResult,
  MemoryTermDocument,
  UpdateChannelGroupInput,
  UpdateChannelUserInput,
  UpdateScheduleInput,
  UserDocument,
  SoulDocument,
  ThreadSnapshot,
  ThingRecord,
  ThreadRecord,
  ThreadWorkspaceChangeDecision,
  ThreadWorkspaceChangeDecisionInput,
  ThreadWorkspaceUpdateInput,
  ToolCallName,
  ToolPreferencesInput,
  TranslateInput,
  RunModeId,
  TranslateResult,
  JotdownMeta,
  JotdownFull,
  JotdownSaveInput,
  SkillCatalogEntry,
  UsageStatsInput,
  UsageStatsResponse,
  PerfStatsResponse,
  WebSearchBrowserImportSource,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'

declare global {
  interface Window {
    api: {
      process: {
        versions: { electron: string; chrome: string; node: string }
        platform: NodeJS.Platform
      }
      onNavigateSettingsTo: (listener: (tab: string) => void) => () => void
      openSettings: (tab?: string) => void
      openTranslator: () => void
      openJotdown: () => void
      hideTranslator: () => void
      hideJotdown: () => void
      pauseGlobalShortcuts: () => void
      resumeGlobalShortcuts: () => void
      navigateToArchivedThread: (threadId: string) => void
      onNavigateToArchivedThread: (listener: (threadId: string) => void) => () => void
      onNavigateToThread: (listener: (threadId: string) => void) => () => void
      setVibrancy: (enabled: boolean) => void
      appUpdate: {
        getStatus: () => Promise<{ state: string; version?: string; error?: string }>
        check: () => void
        download: () => void
        install: () => void
        openRelease: () => void
        getReleaseNotes: (version: string) => Promise<string>
        setChannel: (channel: 'stable' | 'beta') => void
        onStatus: (
          listener: (status: { state: string; version?: string; error?: string }) => void
        ) => () => void
      }
      yachiyo: {
        searchThreadsAndMessages: (
          input: SearchThreadsAndMessagesInput
        ) => Promise<ThreadSearchResult[]>
        searchWorkspaceFiles: (input: SearchWorkspaceFilesInput) => Promise<FileMentionCandidate[]>
        listThings: (input?: { includeInactive?: boolean }) => Promise<ThingRecord[]>
        getThing: (input: { name: string }) => Promise<ThingRecord | undefined>
        reactivateThing: (input: { name: string }) => Promise<ThingRecord | undefined>
        deleteThing: (input: { name: string }) => Promise<boolean>
        continueThingInNewChat: (input: { name: string }) => Promise<ThreadRecord>
        archiveThread: (input: { threadId: string }) => Promise<void>
        bootstrap: () => Promise<BootstrapPayload>
        createBranch: (input: { threadId: string; messageId: string }) => Promise<ThreadSnapshot>
        compactThreadToAnotherThread: (input: CompactThreadInput) => Promise<CompactThreadAccepted>
        createThread: (input?: {
          workspacePath?: string
          createdFromEssentialId?: string
          privacyMode?: boolean
          enabledTools?: ToolCallName[]
          runMode?: RunModeId
          reasoningEffort?: ComposerReasoningSelection
        }) => Promise<ThreadRecord>
        deleteThread: (input: { threadId: string }) => Promise<void>
        deleteMessage: (input: { threadId: string; messageId: string }) => Promise<ThreadSnapshot>
        editMessage: (input: EditMessageInput) => Promise<ChatAccepted>
        openThreadWorkspace: (input: { threadId: string }) => Promise<void>
        getThreadWorkspaceChangeDecision: (
          input: ThreadWorkspaceChangeDecisionInput
        ) => Promise<ThreadWorkspaceChangeDecision>
        readThreadPlanDocument: (
          input: ReadThreadPlanDocumentInput
        ) => Promise<ReadThreadPlanDocumentResult>
        acceptThreadPlanDocument: (input: AcceptThreadPlanDocumentInput) => Promise<ChatAccepted>
        pickCodexSessionFile: () => Promise<string | null>
        pickWorkspaceDirectory: () => Promise<string | null>
        createFolderForThreads: (input: { threadIds: string[] }) => Promise<FolderRecord>
        renameFolder: (input: { folderId: string; title: string }) => Promise<FolderRecord>
        setFolderColor: (input: {
          folderId: string
          colorTag: string | null
        }) => Promise<FolderRecord>
        deleteFolder: (input: { folderId: string }) => Promise<void>
        moveThreadToFolder: (input: {
          threadId: string
          folderId: string | null
        }) => Promise<ThreadRecord>
        renameThread: (input: { threadId: string; title: string }) => Promise<ThreadRecord>
        setThreadColor: (input: {
          threadId: string
          colorTag: ThreadColorTag | null
        }) => Promise<ThreadRecord>
        setThreadIcon: (input: { threadId: string; icon: string | null }) => Promise<ThreadRecord>
        showEmojiPanel: () => Promise<void>
        restoreThread: (input: { threadId: string }) => Promise<ThreadRecord>
        saveToolPreferences: (input: ToolPreferencesInput) => Promise<SettingsConfig>
        clearRecapText: (input: { threadId: string }) => Promise<void>
        requestRecap: (input: { threadId: string }) => Promise<string | null>
        sendChat: (input: SendChatInput) => Promise<ChatAccepted>
        retryMessage: (input: RetryInput) => Promise<RetryAccepted>
        saveThread: (input: SaveThreadInput) => Promise<SaveThreadResult>
        updateThreadWorkspace: (input: ThreadWorkspaceUpdateInput) => Promise<ThreadRecord>
        selectReplyBranch: (input: {
          threadId: string
          assistantMessageId: string
        }) => Promise<ThreadRecord>
        cancelRun: (input: { runId: string }) => Promise<void>
        withdrawPendingSteer: (input: { threadId: string }) => Promise<void>
        answerToolQuestion: (input: AnswerToolQuestionInput) => Promise<void>
        translate: (input: TranslateInput) => Promise<TranslateResult>
        onTranslateDelta: (listener: (delta: string) => void) => () => void

        // Jotdowns
        listJotdowns: () => Promise<JotdownMeta[]>
        loadJotdown: (input: { id: string }) => Promise<JotdownFull>
        saveJotdown: (input: JotdownSaveInput) => Promise<JotdownMeta>
        createJotdown: () => Promise<JotdownFull>
        deleteJotdown: (input: { id: string }) => Promise<void>
        pruneEmptyTemporaryWorkspaces: () => Promise<number>
        revealFile: (input: { path: string }) => Promise<void>
        resolveFileReferences: (
          input: ResolveFileReferencesInput
        ) => Promise<ResolvedFileReference[]>
        openFile: (input: { path: string }) => Promise<void>
        copyImageToClipboard: (input: { src: string }) => Promise<void>
        savePngFile: (input: {
          pngData: ArrayBuffer
          defaultFilename?: string
        }) => Promise<{ canceled: true } | { canceled: false; filePath: string }>
        openFileInEditor: (input: { path: string; editorApp: string }) => Promise<void>
        getUsageStats: (input: UsageStatsInput) => Promise<UsageStatsResponse>
        getPerfStats: () => Promise<PerfStatsResponse>

        getConfig: () => Promise<SettingsConfig>
        getSoulDocument: () => Promise<SoulDocument>
        addSoulTrait: (input: { trait: string }) => Promise<SoulDocument>
        deleteSoulTrait: (input: { trait: string }) => Promise<SoulDocument>
        getMemoryTermDocument: (input?: GetMemoryTermDocumentInput) => Promise<MemoryTermDocument>
        deleteMemoryTerm: (input: DeleteMemoryTermInput) => Promise<DeleteMemoryTermResult>
        listActivitySourceRecords: (
          input?: ListActivitySourceRecordsInput
        ) => Promise<ListActivitySourceRecordsResult>
        getUserDocument: () => Promise<UserDocument>
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
        listBrowserAutomationSessions: (
          input: ListBrowserAutomationSessionsInput
        ) => Promise<BrowserAutomationSessionRecord[]>
        showBrowserAutomationSession: (
          input: ShowBrowserAutomationSessionInput
        ) => Promise<BrowserAutomationSessionRecord>
        hideBrowserAutomationSession: (input: HideBrowserAutomationSessionInput) => Promise<void>
        setBrowserAutomationSessionBounds: (
          input: SetBrowserAutomationSessionBoundsInput
        ) => Promise<BrowserAutomationSessionRecord>
        setThreadPrivacyMode: (input: {
          threadId: string
          enabled: boolean
        }) => Promise<ThreadRecord>
        setThreadModelOverride: (input: {
          threadId: string
          modelOverride: ThreadModelOverride | null
        }) => Promise<ThreadRecord>
        setThreadReasoningEffort: (input: {
          threadId: string
          reasoningEffort: ComposerReasoningSelection | null
        }) => Promise<ThreadRecord>
        setThreadToolMode: (input: {
          threadId: string
          enabledTools: ToolCallName[]
          runMode?: RunModeId
        }) => Promise<ThreadRecord>
        setThreadRuntimeBinding: (input: {
          threadId: string
          runtimeBinding: ThreadRuntimeBinding | null
        }) => Promise<ThreadRecord>
        regenerateThreadTitle: (input: { threadId: string }) => Promise<ThreadRecord>
        starThread: (input: { threadId: string; starred: boolean }) => Promise<ThreadRecord>
        readClipboardFilePaths: () => Promise<{
          files: { filename: string; mediaType: string; dataUrl: string }[]
          rejected: import('@yachiyo/shared/attachmentFileTypes').AttachmentFileRejectionRecord[]
        }>
        readAttachmentFile: (input: { filePath: string; mediaType: string }) => Promise<string>
        downloadRemoteImageForMessage: (input: {
          threadId: string
          messageId: string
          url: string
        }) => Promise<{
          absPath: string
          message: import('@yachiyo/shared/protocol').MessageRecord
        }>
        listDiscoveredApps: () => Promise<{
          editors: { name: string; iconDataUrl?: string }[]
          terminals: { name: string; iconDataUrl?: string }[]
          markdownEditors: { name: string; iconDataUrl?: string }[]
        }>
        openWorkspaceWithApp: (input: { threadId: string; appName: string }) => Promise<void>
        loadThreadData: (input: { threadId: string; includeMessages?: boolean }) => Promise<{
          messages: import('@yachiyo/shared/protocol').MessageRecord[]
          toolCalls: import('@yachiyo/shared/protocol').ToolCallRecord[]
          runs: import('@yachiyo/shared/protocol').RunRecord[]
          scheduleRun?: import('@yachiyo/shared/protocol').ScheduleRunRecord
        }>
        listBackgroundTasks: (input?: {
          threadId?: string
        }) => Promise<import('@yachiyo/shared/protocol').BackgroundTaskSnapshot[]>
        getBackgroundTaskLog: (input: {
          threadId: string
          taskId: string
          maxBytes?: number
        }) => Promise<import('@yachiyo/shared/protocol').BackgroundTaskLogSnapshot>
        cancelBackgroundTask: (input: { taskId: string }) => Promise<boolean>
        listExternalThreads: () => Promise<ThreadRecord[]>
        listChannelUsers: () => Promise<ChannelUserRecord[]>
        updateChannelUser: (input: UpdateChannelUserInput) => Promise<ChannelUserRecord>
        listChannelGroups: () => Promise<ChannelGroupRecord[]>
        updateChannelGroup: (input: UpdateChannelGroupInput) => Promise<ChannelGroupRecord>
        clearGroupMonitorBuffer: (groupId: string) => Promise<void>
        getChannelsConfig: () => Promise<ChannelsConfig>
        saveChannelsConfig: (input: ChannelsConfig) => Promise<ChannelsConfig>
        restartChannelService: (
          platform: 'telegram' | 'qq' | 'discord' | 'qqbot' | 'all'
        ) => Promise<void>

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
        triggerScheduleNow: (input: { scheduleId: string }) => Promise<void>
        markThreadAsRead: (input: { threadId: string }) => Promise<ThreadRecord>

        // File snapshots
        getSnapshotDiff: (input: {
          runId: string
          workspacePath: string
        }) => Promise<import('@yachiyo/shared/fileSnapshot').FileChangeForReview[]>
        revertSnapshotFile: (input: {
          runId: string
          workspacePath: string
          relativePath: string
        }) => Promise<void>
        revertSnapshotRun: (input: { runId: string; workspacePath: string }) => Promise<void>
        listRunSnapshots: (input: {
          workspacePath: string
        }) => Promise<import('@yachiyo/shared/fileSnapshot').SnapshotSummary[]>
        restoreToCheckpoint: (input: { runId: string; workspacePath: string }) => Promise<string[]>

        showNotification: (input: ShowNotificationInput) => void
        beep: () => void
        subscribe: (listener: (event: YachiyoServerEvent) => void) => () => void
      }
    }
  }
}
