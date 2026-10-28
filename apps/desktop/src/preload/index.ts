import type { ReadAppLogsResult } from '@yachiyo/shared/appLogs'
import { createAppServerClient, openBrowserAppSocket } from '@yachiyo/shared/appServer/client'
import { APP_RPC_METHODS, type AppRpcMethod } from '@yachiyo/shared/appServer/methods'
import type { AppServerAddress } from '@yachiyo/shared/appServer/protocol'
import type { DiscoveredApp } from '@yachiyo/shared/discoveredApp'
import type {
  AcceptThreadPlanDocumentInput,
  AnswerToolQuestionInput,
  BrowserAutomationSessionRecord,
  ChannelGroupRecord,
  ChannelsConfig,
  ChannelUserRecord,
  ChatAccepted,
  CompactThreadAccepted,
  CompactThreadInput,
  ComposerReasoningSelection,
  ControlBrowserAutomationSessionInput,
  DeleteMemoryTermInput,
  DeleteMemoryTermResult,
  DeleteThingInput,
  EditMessageInput,
  FolderRecord,
  GetMemoryTermDocumentInput,
  HideBrowserAutomationSessionInput,
  ImportWebSearchBrowserSessionInput,
  JotdownSaveInput,
  ListActivitySourceRecordsInput,
  ListActivitySourceRecordsResult,
  ListBrowserAutomationSessionsInput,
  ListSkillsInput,
  ManagedPythonEnvironmentAction,
  ManagedPythonEnvironmentStatus,
  MemoryTermDocument,
  OpenBrowserPreviewInput,
  ProviderConfig,
  ProviderSettings,
  ReadThreadPlanDocumentInput,
  ReadThreadPlanDocumentResult,
  ReleaseBrowserPreviewInput,
  ReleaseBrowserPreviewResult,
  RemoveThingSourceInput,
  RenameThingInput,
  ResolvedFileReference,
  ResolveFileReferencesInput,
  ResolveSyncConflictInput,
  RetryInput,
  RunModeId,
  SaveThreadInput,
  SearchThreadsAndMessagesInput,
  SearchWorkspaceFilesInput,
  SendChatInput,
  SetBrowserAutomationSessionBoundsInput,
  SettingsConfig,
  ShowBrowserAutomationSessionInput,
  ShowNotificationInput,
  SoulDocument,
  SubagentSnapshot,
  TestSubagentProfileInput,
  ThingRecord,
  ThreadColorTag,
  ThreadModelOverride,
  ThreadRecord,
  ThreadRuntimeBinding,
  ThreadSearchResult,
  ThreadWorkspaceChangeDecision,
  ThreadWorkspaceChangeDecisionInput,
  ThreadWorkspaceUpdateInput,
  ToolPreferencesInput,
  TranslateInput,
  TranslateResult,
  UpdateChannelGroupInput,
  UpdateChannelUserInput,
  UserDocument,
  YachiyoServerEvent
} from '@yachiyo/shared/protocol'
import type { ComposerPredictionInput } from '@yachiyo/shared/protocol/composerPrediction'
import type {
  ExportProviderBackupInput,
  ExportProviderBackupResult,
  ImportProviderBackupInput,
  ImportProviderBackupResult
} from '@yachiyo/shared/providerBackup'
import { contextBridge, ipcRenderer } from 'electron'

const translateListeners = new Set<(delta: string) => void>()
const appClient = createAppServerClient({
  resolveAddress: () =>
    ipcRenderer.invoke('yachiyo:app-server-session') as Promise<AppServerAddress>,
  connect: openBrowserAppSocket,
  onReset: () => window.location.reload(),
  onConnectionError: (error) => console.error('[app-server]', error)
})
function invokeApp<T>(method: AppRpcMethod, ...args: unknown[]): Promise<T> {
  return appClient.call(method, args) as Promise<T>
}
window.addEventListener('unload', () => appClient.close())

const api = {
  process: {
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    },
    platform: process.platform
  },
  onNavigateSettingsTo: (listener: (tab: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, tab: string): void => {
      listener(tab)
    }
    ipcRenderer.on('navigate-settings-to', handler)
    return () => ipcRenderer.off('navigate-settings-to', handler)
  },
  openSettings: (tab?: string) => ipcRenderer.send('open-settings', tab),
  openNotificationSettings: (): void => ipcRenderer.send('open-notification-settings'),
  openTranslator: () => ipcRenderer.send('open-translator'),
  openJotdown: () => ipcRenderer.send('open-jotdown'),
  hideTranslator: () => ipcRenderer.send('hide-translator'),
  hideJotdown: () => ipcRenderer.send('hide-jotdown'),
  pauseGlobalShortcuts: () => ipcRenderer.send('pause-global-shortcuts'),
  resumeGlobalShortcuts: () => ipcRenderer.send('resume-global-shortcuts'),
  navigateToArchivedThread: (threadId: string) =>
    ipcRenderer.send('navigate-to-archived-thread', threadId),
  onNavigateToArchivedThread: (listener: (threadId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, threadId: string): void => {
      listener(threadId)
    }
    ipcRenderer.on('navigate-to-archived-thread', handler)
    return () => ipcRenderer.off('navigate-to-archived-thread', handler)
  },
  onNavigateToThread: (listener: (threadId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, threadId: string): void => {
      listener(threadId)
    }
    ipcRenderer.on('navigate-to-thread', handler)
    return () => ipcRenderer.off('navigate-to-thread', handler)
  },
  setVibrancy: (enabled: boolean) => ipcRenderer.send('set-vibrancy', enabled),
  setTitleBarOverlay: (appearance: { symbolColor: string; height: number }) =>
    ipcRenderer.send('set-title-bar-overlay', appearance),
  appUpdate: {
    getStatus: (): Promise<{ state: string; version?: string; error?: string }> =>
      ipcRenderer.invoke('app-update:get-status'),
    check: () => ipcRenderer.send('app-update:check'),
    download: () => ipcRenderer.send('app-update:download'),
    install: () => ipcRenderer.send('app-update:install'),
    openRelease: () => ipcRenderer.send('app-update:open-release'),
    getReleaseNotes: (version: string): Promise<string> =>
      ipcRenderer.invoke('app-update:get-release-notes', version),
    setChannel: (channel: 'stable' | 'beta') => ipcRenderer.send('app-update:set-channel', channel),
    onStatus: (
      listener: (status: { state: string; version?: string; error?: string }) => void
    ): (() => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        status: { state: string; version?: string; error?: string }
      ): void => {
        listener(status)
      }
      ipcRenderer.on('app-update:status', handler)
      return () => {
        ipcRenderer.off('app-update:status', handler)
      }
    }
  },
  runtimeHealth: {
    getStatus: (): Promise<{ crashed: boolean }> => ipcRenderer.invoke('yachiyo:runtime-health'),
    restart: (): Promise<{ restarted: boolean }> => ipcRenderer.invoke('yachiyo:restart-runtime'),
    openLogs: (): Promise<void> => ipcRenderer.invoke('yachiyo:open-logs-folder'),
    onStatus: (listener: (status: { crashed: boolean }) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: { crashed: boolean }): void => {
        listener(status)
      }
      ipcRenderer.on('yachiyo:runtime-health-status', handler)
      return () => {
        ipcRenderer.off('yachiyo:runtime-health-status', handler)
      }
    }
  },
  appLogs: {
    read: (input?: { afterByte?: number }): Promise<ReadAppLogsResult> =>
      ipcRenderer.invoke('yachiyo:read-app-logs', input)
  },
  yachiyo: {
    searchThreadsAndMessages: (
      input: SearchThreadsAndMessagesInput
    ): Promise<ThreadSearchResult[]> => invokeApp(APP_RPC_METHODS.searchThreadsAndMessages, input),
    searchWorkspaceFiles: (input: SearchWorkspaceFilesInput) =>
      invokeApp(APP_RPC_METHODS.searchWorkspaceFiles, input),
    listThings: (input?: { includeInactive?: boolean }): Promise<ThingRecord[]> =>
      invokeApp(APP_RPC_METHODS.listThings, input),
    getThing: (input: { name: string }): Promise<ThingRecord | undefined> =>
      invokeApp(APP_RPC_METHODS.getThing, input),
    restoreThing: (input: { name: string }): Promise<ThingRecord | undefined> =>
      invokeApp(APP_RPC_METHODS.restoreThing, input),
    renameThing: (input: RenameThingInput): Promise<ThingRecord | undefined> =>
      invokeApp(APP_RPC_METHODS.renameThing, input),
    deleteThing: (input: DeleteThingInput): Promise<boolean> =>
      invokeApp(APP_RPC_METHODS.deleteThing, input),
    removeThingSource: (input: RemoveThingSourceInput): Promise<boolean> =>
      invokeApp(APP_RPC_METHODS.removeThingSource, input),
    continueThingInNewChat: (input: { name: string }): Promise<ThreadRecord> =>
      invokeApp(APP_RPC_METHODS.continueThingInNewChat, input),
    archiveThread: (input: { threadId: string }) => invokeApp(APP_RPC_METHODS.archiveThread, input),
    bootstrap: () => invokeApp(APP_RPC_METHODS.bootstrap),
    createBranch: (input: {
      threadId: string
      messageId: string
      truncateBeforeToolCallId?: string
    }) => invokeApp(APP_RPC_METHODS.createBranch, input),
    compactThreadToAnotherThread: (input: CompactThreadInput): Promise<CompactThreadAccepted> =>
      invokeApp(APP_RPC_METHODS.compactThreadToAnotherThread, input),
    createThread: (input?: {
      workspacePath?: string
      createdFromEssentialId?: string
      privacyMode?: boolean
      modelOverride?: ThreadModelOverride
      runMode?: RunModeId
      reasoningEffort?: ComposerReasoningSelection
    }) => invokeApp(APP_RPC_METHODS.createThread, input),
    deleteThread: (input: { threadId: string }) => invokeApp(APP_RPC_METHODS.deleteThread, input),
    deleteMessage: (input: { threadId: string; messageId: string }) =>
      invokeApp(APP_RPC_METHODS.deleteMessage, input),
    editMessage: (input: EditMessageInput) => invokeApp(APP_RPC_METHODS.editMessage, input),
    openThreadWorkspace: (input: { threadId: string }) =>
      ipcRenderer.invoke('yachiyo:open-thread-workspace', input),
    getThreadWorkspaceChangeDecision: (
      input: ThreadWorkspaceChangeDecisionInput
    ): Promise<ThreadWorkspaceChangeDecision> =>
      invokeApp(APP_RPC_METHODS.getThreadWorkspaceChangeDecision, input),
    readThreadPlanDocument: (
      input: ReadThreadPlanDocumentInput
    ): Promise<ReadThreadPlanDocumentResult> =>
      invokeApp(APP_RPC_METHODS.readThreadPlanDocument, input),
    acceptThreadPlanDocument: (input: AcceptThreadPlanDocumentInput): Promise<ChatAccepted> =>
      invokeApp(APP_RPC_METHODS.acceptThreadPlanDocument, input),
    pickCodexSessionFile: () => ipcRenderer.invoke('yachiyo:pick-codex-session-file'),
    pickWorkspaceDirectory: () => ipcRenderer.invoke('yachiyo:pick-workspace-directory'),
    pickSyncDirectory: () => ipcRenderer.invoke('yachiyo:pick-sync-directory'),
    createFolderForThreads: (input: { threadIds: string[] }): Promise<FolderRecord> =>
      invokeApp(APP_RPC_METHODS.createFolderForThreads, input),
    renameFolder: (input: { folderId: string; title: string }): Promise<FolderRecord> =>
      invokeApp(APP_RPC_METHODS.renameFolder, input),
    setFolderColor: (input: { folderId: string; colorTag: string | null }): Promise<FolderRecord> =>
      invokeApp(APP_RPC_METHODS.setFolderColor, input),
    deleteFolder: (input: { folderId: string }): Promise<void> =>
      invokeApp(APP_RPC_METHODS.deleteFolder, input),
    moveThreadToFolder: (input: {
      threadId: string
      folderId: string | null
    }): Promise<ThreadRecord> => invokeApp(APP_RPC_METHODS.moveThreadToFolder, input),
    renameThread: (input: { threadId: string; title: string }) =>
      invokeApp(APP_RPC_METHODS.renameThread, input),
    setThreadColor: (input: { threadId: string; colorTag: ThreadColorTag | null }) =>
      invokeApp(APP_RPC_METHODS.setThreadColor, input),
    setThreadIcon: (input: { threadId: string; icon: string | null }) =>
      invokeApp(APP_RPC_METHODS.setThreadIcon, input),
    showEmojiPanel: () => ipcRenderer.invoke('yachiyo:show-emoji-panel'),
    restoreThread: (input: { threadId: string }) => invokeApp(APP_RPC_METHODS.restoreThread, input),
    saveToolPreferences: (input: ToolPreferencesInput) =>
      invokeApp(APP_RPC_METHODS.saveToolPreferences, input),
    clearRecapText: (input: { threadId: string }) =>
      invokeApp(APP_RPC_METHODS.clearRecapText, input),
    requestRecap: (input: { threadId: string }) => invokeApp(APP_RPC_METHODS.requestRecap, input),
    sendChat: (input: SendChatInput) => invokeApp(APP_RPC_METHODS.sendChat, input),
    retryMessage: (input: RetryInput) => invokeApp(APP_RPC_METHODS.retryMessage, input),
    saveThread: (input: SaveThreadInput) => invokeApp(APP_RPC_METHODS.saveThread, input),
    updateThreadWorkspace: (input: ThreadWorkspaceUpdateInput) =>
      invokeApp(APP_RPC_METHODS.updateThreadWorkspace, input),
    selectReplyBranch: (input: { threadId: string; assistantMessageId: string }) =>
      invokeApp(APP_RPC_METHODS.selectReplyBranch, input),
    cancelRun: (input: { runId: string }) => invokeApp(APP_RPC_METHODS.cancelRun, input),
    withdrawPendingSteer: (input: { threadId: string }) =>
      invokeApp(APP_RPC_METHODS.withdrawPendingSteer, input),
    answerToolQuestion: (input: AnswerToolQuestionInput) =>
      invokeApp(APP_RPC_METHODS.answerToolQuestion, input),
    predictComposer: (input: ComposerPredictionInput): Promise<string> =>
      invokeApp(APP_RPC_METHODS.predictComposer, input),
    translate: (input: TranslateInput): Promise<TranslateResult> =>
      appClient.call(APP_RPC_METHODS.translate, [input], {
        onProgress: (delta) => {
          for (const listener of translateListeners) listener(delta as string)
        }
      }) as Promise<TranslateResult>,
    onTranslateDelta: (listener: (delta: string) => void): (() => void) => {
      translateListeners.add(listener)
      return () => translateListeners.delete(listener)
    },
    listJotdowns: (): Promise<import('@yachiyo/shared/protocol').JotdownMeta[]> =>
      invokeApp(APP_RPC_METHODS.jotdownList),
    loadJotdown: (input: { id: string }): Promise<import('@yachiyo/shared/protocol').JotdownFull> =>
      invokeApp(APP_RPC_METHODS.jotdownLoad, input),
    saveJotdown: (
      input: JotdownSaveInput
    ): Promise<import('@yachiyo/shared/protocol').JotdownMeta> =>
      invokeApp(APP_RPC_METHODS.jotdownSave, input),
    createJotdown: (): Promise<import('@yachiyo/shared/protocol').JotdownFull> =>
      invokeApp(APP_RPC_METHODS.jotdownCreate),
    deleteJotdown: (input: { id: string }): Promise<void> =>
      invokeApp(APP_RPC_METHODS.jotdownDelete, input),
    pruneEmptyTemporaryWorkspaces: (): Promise<number> =>
      invokeApp(APP_RPC_METHODS.pruneEmptyTemporaryWorkspaces),
    revealFile: (input: {
      path: string
      threadId?: string
      workspacePath?: string | null
      workspaceOnly?: boolean
    }): Promise<void> => ipcRenderer.invoke('yachiyo:reveal-file', input),
    resolveFileReferences: (input: ResolveFileReferencesInput): Promise<ResolvedFileReference[]> =>
      invokeApp(APP_RPC_METHODS.resolveFileReferences, input),
    openFile: (input: {
      path: string
      appSelection?: string
      appKind?: 'editor' | 'markdown'
      threadId?: string
      workspacePath?: string | null
      workspaceOnly?: boolean
    }): Promise<void> => ipcRenderer.invoke('yachiyo:open-file', input),
    copyImageToClipboard: (input: { src: string }): Promise<void> =>
      ipcRenderer.invoke('yachiyo:copy-image-to-clipboard', input),
    savePngFile: (input: {
      pngData: ArrayBuffer
      defaultFilename?: string
    }): Promise<{ canceled: true } | { canceled: false; filePath: string }> =>
      ipcRenderer.invoke('yachiyo:save-png-file', input),
    savePngFiles: (input: {
      pages: ArrayBuffer[]
      filenamePrefix?: string
    }): Promise<
      { canceled: true } | { canceled: false; directoryPath: string; filePaths: string[] }
    > => ipcRenderer.invoke('yachiyo:save-png-files', input),
    getUsageStats: (
      input: import('@yachiyo/shared/protocol').UsageStatsInput
    ): Promise<import('@yachiyo/shared/protocol').UsageStatsResponse> =>
      invokeApp(APP_RPC_METHODS.getUsageStats, input),
    getPerfStats: (): Promise<import('@yachiyo/shared/protocol').PerfStatsResponse> =>
      invokeApp(APP_RPC_METHODS.getPerfStats),

    getConfig: () => invokeApp(APP_RPC_METHODS.getConfig),
    getSoulDocument: (): Promise<SoulDocument> => invokeApp(APP_RPC_METHODS.getSoulDocument),
    addSoulTrait: (input: { trait: string }): Promise<SoulDocument> =>
      invokeApp(APP_RPC_METHODS.addSoulTrait, input),
    deleteSoulTrait: (input: { trait: string }): Promise<SoulDocument> =>
      invokeApp(APP_RPC_METHODS.deleteSoulTrait, input),
    getMemoryTermDocument: (input?: GetMemoryTermDocumentInput): Promise<MemoryTermDocument> =>
      invokeApp(APP_RPC_METHODS.getMemoryTermDocument, input),
    deleteMemoryTerm: (input: DeleteMemoryTermInput): Promise<DeleteMemoryTermResult> =>
      invokeApp(APP_RPC_METHODS.deleteMemoryTerm, input),
    listActivitySourceRecords: (
      input?: ListActivitySourceRecordsInput
    ): Promise<ListActivitySourceRecordsResult> =>
      invokeApp(APP_RPC_METHODS.listActivitySourceRecords, input),
    getUserDocument: (): Promise<UserDocument> => invokeApp(APP_RPC_METHODS.getUserDocument),
    testSubagentProfile: (input: TestSubagentProfileInput) =>
      invokeApp(APP_RPC_METHODS.testSubagentProfile, input),
    getSettings: () => invokeApp(APP_RPC_METHODS.getSettings),
    getPythonEnvironmentStatus: (): Promise<ManagedPythonEnvironmentStatus> =>
      invokeApp(APP_RPC_METHODS.getPythonEnvironmentStatus),
    managePythonEnvironment: (
      action: ManagedPythonEnvironmentAction
    ): Promise<ManagedPythonEnvironmentStatus> =>
      invokeApp(APP_RPC_METHODS.managePythonEnvironment, { action }),
    getSyncStatus: () => invokeApp(APP_RPC_METHODS.getSyncStatus),
    initSync: () => invokeApp(APP_RPC_METHODS.initSync),
    runSyncNow: () => invokeApp(APP_RPC_METHODS.runSyncNow),
    listSyncConflicts: () => invokeApp(APP_RPC_METHODS.listSyncConflicts),
    resolveSyncConflict: (input: ResolveSyncConflictInput) =>
      invokeApp(APP_RPC_METHODS.resolveSyncConflict, input),
    getRemoteStatus: () => invokeApp(APP_RPC_METHODS.remoteStatus),
    activateRemoteRelay: (code: string) => invokeApp(APP_RPC_METHODS.remoteActivateRelay, { code }),
    createRemotePairing: () => invokeApp(APP_RPC_METHODS.remoteCreatePairing),
    listRemotePairings: () => invokeApp(APP_RPC_METHODS.remoteListPairings),
    revokeRemotePairing: (pairingId: string) =>
      invokeApp(APP_RPC_METHODS.remoteRevokePairing, { pairingId }),
    saveConfig: (input: SettingsConfig) => invokeApp(APP_RPC_METHODS.saveConfig, input),
    saveUserDocument: (input: { content: string }): Promise<UserDocument> =>
      invokeApp(APP_RPC_METHODS.saveUserDocument, input),
    saveSettings: (input: Partial<ProviderSettings>) =>
      invokeApp(APP_RPC_METHODS.saveSettings, input),
    exportProviderBackup: (input: ExportProviderBackupInput): Promise<ExportProviderBackupResult> =>
      ipcRenderer.invoke('yachiyo:export-provider-backup', input),
    importProviderBackup: (input: ImportProviderBackupInput): Promise<ImportProviderBackupResult> =>
      ipcRenderer.invoke('yachiyo:import-provider-backup', input),
    upsertProvider: (input: ProviderConfig) => invokeApp(APP_RPC_METHODS.upsertProvider, input),
    removeProvider: (input: { name: string }) => invokeApp(APP_RPC_METHODS.removeProvider, input),
    enableProviderModel: (input: { name: string; model: string }) =>
      invokeApp(APP_RPC_METHODS.enableProviderModel, input),
    disableProviderModel: (input: { name: string; model: string }) =>
      invokeApp(APP_RPC_METHODS.disableProviderModel, input),
    fetchProviderModels: (input: ProviderConfig) =>
      invokeApp(APP_RPC_METHODS.fetchProviderModels, input),
    listSkills: (input?: ListSkillsInput) => invokeApp(APP_RPC_METHODS.listSkills, input),
    openSkillsFolder: () => ipcRenderer.invoke('yachiyo:open-skills-folder'),
    listWebSearchBrowserImportSources: () =>
      invokeApp(APP_RPC_METHODS.listWebSearchBrowserImportSources),
    importWebSearchBrowserSession: (input: ImportWebSearchBrowserSessionInput) =>
      invokeApp(APP_RPC_METHODS.importWebSearchBrowserSession, input),
    listBrowserAutomationSessions: (
      input: ListBrowserAutomationSessionsInput
    ): Promise<BrowserAutomationSessionRecord[]> =>
      ipcRenderer.invoke('yachiyo:list-browser-automation-sessions', input),
    controlBrowserAutomationSession: (
      input: ControlBrowserAutomationSessionInput
    ): Promise<BrowserAutomationSessionRecord> =>
      ipcRenderer.invoke('yachiyo:control-browser-automation-session', input),
    showBrowserAutomationSession: (
      input: ShowBrowserAutomationSessionInput
    ): Promise<BrowserAutomationSessionRecord> =>
      ipcRenderer.invoke('yachiyo:show-browser-automation-session', input),
    openBrowserPreview: (input: OpenBrowserPreviewInput): Promise<BrowserAutomationSessionRecord> =>
      ipcRenderer.invoke('yachiyo:open-browser-preview', input),
    releaseBrowserPreview: (
      input: ReleaseBrowserPreviewInput
    ): Promise<ReleaseBrowserPreviewResult> =>
      ipcRenderer.invoke('yachiyo:release-browser-preview', input),
    hideBrowserAutomationSession: (input: HideBrowserAutomationSessionInput): Promise<void> =>
      ipcRenderer.invoke('yachiyo:hide-browser-automation-session', input),
    setBrowserAutomationSessionBounds: (
      input: SetBrowserAutomationSessionBoundsInput
    ): Promise<BrowserAutomationSessionRecord> =>
      ipcRenderer.invoke('yachiyo:set-browser-automation-session-bounds', input),
    setThreadPrivacyMode: (input: { threadId: string; enabled: boolean }): Promise<ThreadRecord> =>
      invokeApp(APP_RPC_METHODS.setThreadPrivacyMode, input),
    setThreadModelOverride: (input: {
      threadId: string
      modelOverride: ThreadModelOverride | null
    }): Promise<ThreadRecord> => invokeApp(APP_RPC_METHODS.setThreadModelOverride, input),
    setThreadReasoningEffort: (input: {
      threadId: string
      reasoningEffort: ComposerReasoningSelection | null
    }): Promise<ThreadRecord> => invokeApp(APP_RPC_METHODS.setThreadReasoningEffort, input),
    setThreadToolMode: (input: { threadId: string; runMode: RunModeId }): Promise<ThreadRecord> =>
      invokeApp(APP_RPC_METHODS.setThreadToolMode, input),
    setThreadRuntimeBinding: (input: {
      threadId: string
      runtimeBinding: ThreadRuntimeBinding | null
    }): Promise<ThreadRecord> => invokeApp(APP_RPC_METHODS.setThreadRuntimeBinding, input),
    regenerateThreadTitle: (input: { threadId: string }): Promise<ThreadRecord> =>
      invokeApp(APP_RPC_METHODS.regenerateThreadTitle, input),
    starThread: (input: { threadId: string; starred: boolean }): Promise<ThreadRecord> =>
      invokeApp(APP_RPC_METHODS.starThread, input),
    readClipboardFilePaths: (): Promise<{
      files: { filename: string; mediaType: string; dataUrl: string }[]
      rejected: import('@yachiyo/shared/attachmentFileTypes').AttachmentFileRejectionRecord[]
    }> => ipcRenderer.invoke('yachiyo:read-clipboard-file-paths'),
    readAttachmentFile: (input: { filePath: string; mediaType: string }): Promise<string> =>
      invokeApp(APP_RPC_METHODS.readAttachmentFile, input),
    readFilePreview: (
      input: import('@yachiyo/shared/filePreview').ReadFilePreviewInput
    ): Promise<import('@yachiyo/shared/filePreview').FilePreviewContent> =>
      invokeApp(APP_RPC_METHODS.readFilePreview, input),
    downloadRemoteImageForMessage: (input: {
      threadId: string
      messageId: string
      url: string
    }): Promise<{
      absPath: string
      message: import('@yachiyo/shared/protocol').MessageRecord
    }> => invokeApp(APP_RPC_METHODS.downloadRemoteImageForMessage, input),
    listDiscoveredApps: (): Promise<{
      editors: DiscoveredApp[]
      terminals: DiscoveredApp[]
      markdownEditors: DiscoveredApp[]
    }> => ipcRenderer.invoke('yachiyo:list-discovered-apps'),
    openWorkspaceWithApp: (input: { threadId: string; appName: string }): Promise<void> =>
      ipcRenderer.invoke('yachiyo:open-workspace-with-app', input),
    loadThreadData: (
      input: import('@yachiyo/shared/protocol').LoadThreadDataInput
    ): Promise<{
      messages: import('@yachiyo/shared/protocol').MessageRecord[]
      queuedFollowUpMessages: import('@yachiyo/shared/protocol').MessageRecord[]
      toolCalls: import('@yachiyo/shared/protocol').ToolCallRecord[]
      runs: import('@yachiyo/shared/protocol').RunRecord[]
      scheduleRun?: import('@yachiyo/shared/protocol').ScheduleRunRecord
    }> => invokeApp(APP_RPC_METHODS.loadThreadData, input),
    listBackgroundTasks: (input?: {
      threadId?: string
    }): Promise<import('@yachiyo/shared/protocol').BackgroundTaskSnapshot[]> =>
      invokeApp(APP_RPC_METHODS.listBackgroundTasks, input),
    getBackgroundTaskLog: (input: {
      threadId: string
      taskId: string
      maxBytes?: number
    }): Promise<import('@yachiyo/shared/protocol').BackgroundTaskLogSnapshot> =>
      invokeApp(APP_RPC_METHODS.getBackgroundTaskLog, input),
    cancelBackgroundTask: (input: { taskId: string }): Promise<boolean> =>
      invokeApp(APP_RPC_METHODS.cancelBackgroundTask, input),
    listSubagents: (input?: { threadId?: string }): Promise<SubagentSnapshot[]> =>
      invokeApp(APP_RPC_METHODS.listSubagents, input),
    cancelSubagent: (input: { agentId: string }): Promise<boolean> =>
      invokeApp(APP_RPC_METHODS.cancelSubagent, input),
    closeSubagent: (input: { agentId: string }): Promise<boolean> =>
      invokeApp(APP_RPC_METHODS.closeSubagent, input),
    cancelRunningSubagents: (input: { threadId: string }): Promise<number> =>
      invokeApp(APP_RPC_METHODS.cancelRunningSubagents, input),
    listExternalThreads: (): Promise<ThreadRecord[]> =>
      invokeApp(APP_RPC_METHODS.listExternalThreads),
    listChannelUsers: (): Promise<ChannelUserRecord[]> =>
      invokeApp(APP_RPC_METHODS.listChannelUsers),
    updateChannelUser: (input: UpdateChannelUserInput): Promise<ChannelUserRecord> =>
      invokeApp(APP_RPC_METHODS.updateChannelUser, input),
    listChannelGroups: (): Promise<ChannelGroupRecord[]> =>
      invokeApp(APP_RPC_METHODS.listChannelGroups),
    updateChannelGroup: (input: UpdateChannelGroupInput): Promise<ChannelGroupRecord> =>
      invokeApp(APP_RPC_METHODS.updateChannelGroup, input),
    clearGroupMonitorBuffer: (groupId: string): Promise<void> =>
      invokeApp(APP_RPC_METHODS.clearGroupMonitorBuffer, { groupId }),
    getChannelsConfig: (): Promise<ChannelsConfig> => invokeApp(APP_RPC_METHODS.getChannelsConfig),
    saveChannelsConfig: (input: ChannelsConfig): Promise<ChannelsConfig> =>
      invokeApp(APP_RPC_METHODS.saveChannelsConfig, input),
    restartChannelService: (
      platform: 'telegram' | 'qq' | 'discord' | 'qqbot' | 'all'
    ): Promise<void> => invokeApp(APP_RPC_METHODS.restartChannelService, { platform }),

    // Schedules
    listSchedules: (): Promise<import('@yachiyo/shared/protocol').ScheduleRecord[]> =>
      invokeApp(APP_RPC_METHODS.listSchedules),
    createSchedule: (
      input: import('@yachiyo/shared/protocol').CreateScheduleInput
    ): Promise<import('@yachiyo/shared/protocol').ScheduleRecord> =>
      invokeApp(APP_RPC_METHODS.createSchedule, input),
    updateSchedule: (
      input: import('@yachiyo/shared/protocol').UpdateScheduleInput
    ): Promise<import('@yachiyo/shared/protocol').ScheduleRecord> =>
      invokeApp(APP_RPC_METHODS.updateSchedule, input),
    deleteSchedule: (input: { id: string }): Promise<void> =>
      invokeApp(APP_RPC_METHODS.deleteSchedule, input),
    enableSchedule: (input: { id: string }): Promise<boolean> =>
      invokeApp(APP_RPC_METHODS.enableSchedule, input),
    disableSchedule: (input: {
      id: string
    }): Promise<import('@yachiyo/shared/protocol').ScheduleRecord> =>
      invokeApp(APP_RPC_METHODS.disableSchedule, input),
    listScheduleRuns: (input: {
      scheduleId: string
      limit?: number
    }): Promise<import('@yachiyo/shared/protocol').ScheduleRunRecord[]> =>
      invokeApp(APP_RPC_METHODS.listScheduleRuns, input),
    listRecentScheduleRuns: (input?: {
      limit?: number
    }): Promise<import('@yachiyo/shared/protocol').ScheduleRunRecord[]> =>
      invokeApp(APP_RPC_METHODS.listRecentScheduleRuns, input),
    triggerScheduleNow: (input: { scheduleId: string }): Promise<void> =>
      invokeApp(APP_RPC_METHODS.triggerScheduleNow, input),
    markThreadAsRead: (input: {
      threadId: string
    }): Promise<import('@yachiyo/shared/protocol').ThreadRecord> =>
      invokeApp(APP_RPC_METHODS.markThreadAsRead, input),

    getSnapshotDiff: (input: {
      runId: string
      workspacePath: string
    }): Promise<import('@yachiyo/shared/fileSnapshot').FileChangeForReview[]> =>
      invokeApp(APP_RPC_METHODS.getSnapshotDiff, input),
    revertSnapshotFile: (input: {
      runId: string
      workspacePath: string
      relativePath: string
    }): Promise<void> => invokeApp(APP_RPC_METHODS.revertSnapshotFile, input),
    revertSnapshotRun: (input: { runId: string; workspacePath: string }): Promise<void> =>
      invokeApp(APP_RPC_METHODS.revertSnapshotRun, input),
    listRunSnapshots: (input: {
      workspacePath: string
    }): Promise<import('@yachiyo/shared/fileSnapshot').SnapshotSummary[]> =>
      invokeApp(APP_RPC_METHODS.listRunSnapshots, input),
    restoreToCheckpoint: (input: { runId: string; workspacePath: string }): Promise<string[]> =>
      invokeApp(APP_RPC_METHODS.restoreToCheckpoint, input),

    showNotification: (input: ShowNotificationInput): void =>
      ipcRenderer.send('yachiyo:show-notification', input),
    beep: (): void => ipcRenderer.send('yachiyo:beep'),
    subscribe: (listener: (event: YachiyoServerEvent) => void): (() => void) =>
      appClient.subscribe((event) => listener(event as YachiyoServerEvent))
  }
}

export type YachiyoPreloadApi = typeof api
export type YachiyoPreloadYachiyoApi = typeof api.yachiyo

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
