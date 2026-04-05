import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  AnswerToolQuestionInput,
  ChannelGroupRecord,
  ChannelsConfig,
  ChannelUserRecord,
  CompactThreadInput,
  CompactThreadAccepted,
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
  TestMemoryConnectionInput,
  TestSubagentProfileInput,
  ThreadModelOverride,
  ThreadRecord,
  ThreadRuntimeBinding,
  ThreadSearchResult,
  MemoryTermDocument,
  UpdateChannelGroupInput,
  UpdateChannelUserInput,
  UserDocument,
  SoulDocument,
  ToolPreferencesInput,
  TranslateInput,
  TranslateResult,
  JotdownSaveInput,
  YachiyoServerEvent
} from '../shared/yachiyo/protocol'

const api = {
  openSettings: (tab?: string) => ipcRenderer.send('open-settings', tab),
  openTranslator: () => ipcRenderer.send('open-translator'),
  openJotdown: () => ipcRenderer.send('open-jotdown'),
  hideTranslator: () => ipcRenderer.send('hide-translator'),
  hideJotdown: () => ipcRenderer.send('hide-jotdown'),
  navigateToArchivedThread: (threadId: string) =>
    ipcRenderer.send('navigate-to-archived-thread', threadId),
  onNavigateToArchivedThread: (listener: (threadId: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, threadId: string): void => {
      listener(threadId)
    }
    ipcRenderer.on('navigate-to-archived-thread', handler)
    return () => ipcRenderer.off('navigate-to-archived-thread', handler)
  },
  setVibrancy: (enabled: boolean) => ipcRenderer.send('set-vibrancy', enabled),
  appUpdate: {
    getStatus: (): Promise<{ state: string; version?: string; error?: string }> =>
      ipcRenderer.invoke('app-update:get-status'),
    check: () => ipcRenderer.send('app-update:check'),
    download: () => ipcRenderer.send('app-update:download'),
    install: () => ipcRenderer.send('app-update:install'),
    openRelease: () => ipcRenderer.send('app-update:open-release'),
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
  yachiyo: {
    searchThreadsAndMessages: (input: { query: string }): Promise<ThreadSearchResult[]> =>
      ipcRenderer.invoke('yachiyo:search-threads-and-messages', input),
    searchWorkspaceFiles: (input: SearchWorkspaceFilesInput) =>
      ipcRenderer.invoke('yachiyo:search-workspace-files', input),
    archiveThread: (input: { threadId: string }) =>
      ipcRenderer.invoke('yachiyo:archive-thread', input),
    bootstrap: () => ipcRenderer.invoke('yachiyo:bootstrap'),
    createBranch: (input: { threadId: string; messageId: string }) =>
      ipcRenderer.invoke('yachiyo:create-branch', input),
    compactThreadToAnotherThread: (input: CompactThreadInput): Promise<CompactThreadAccepted> =>
      ipcRenderer.invoke('yachiyo:compact-thread-to-another-thread', input),
    createThread: (input?: {
      workspacePath?: string
      createdFromEssentialId?: string
      privacyMode?: boolean
    }) => ipcRenderer.invoke('yachiyo:create-thread', input),
    deleteThread: (input: { threadId: string }) =>
      ipcRenderer.invoke('yachiyo:delete-thread', input),
    deleteMessage: (input: { threadId: string; messageId: string }) =>
      ipcRenderer.invoke('yachiyo:delete-message', input),
    editMessage: (input: EditMessageInput) => ipcRenderer.invoke('yachiyo:edit-message', input),
    openThreadWorkspace: (input: { threadId: string }) =>
      ipcRenderer.invoke('yachiyo:open-thread-workspace', input),
    pickWorkspaceDirectory: () => ipcRenderer.invoke('yachiyo:pick-workspace-directory'),
    renameThread: (input: { threadId: string; title: string }) =>
      ipcRenderer.invoke('yachiyo:rename-thread', input),
    setThreadIcon: (input: { threadId: string; icon: string | null }) =>
      ipcRenderer.invoke('yachiyo:set-thread-icon', input),
    showEmojiPanel: () => ipcRenderer.invoke('yachiyo:show-emoji-panel'),
    restoreThread: (input: { threadId: string }) =>
      ipcRenderer.invoke('yachiyo:restore-thread', input),
    saveToolPreferences: (input: ToolPreferencesInput) =>
      ipcRenderer.invoke('yachiyo:save-tool-preferences', input),
    sendChat: (input: SendChatInput) => ipcRenderer.invoke('yachiyo:send-chat', input),
    retryMessage: (input: RetryInput) => ipcRenderer.invoke('yachiyo:retry-message', input),
    saveThread: (input: SaveThreadInput) => ipcRenderer.invoke('yachiyo:save-thread', input),
    updateThreadWorkspace: (input: { threadId: string; workspacePath?: string | null }) =>
      ipcRenderer.invoke('yachiyo:update-thread-workspace', input),
    selectReplyBranch: (input: { threadId: string; assistantMessageId: string }) =>
      ipcRenderer.invoke('yachiyo:select-reply-branch', input),
    cancelRun: (input: { runId: string }) => ipcRenderer.invoke('yachiyo:cancel-run', input),
    answerToolQuestion: (input: AnswerToolQuestionInput) =>
      ipcRenderer.invoke('yachiyo:answer-tool-question', input),
    translate: (input: TranslateInput): Promise<TranslateResult> =>
      ipcRenderer.invoke('yachiyo:translate', input),
    onTranslateDelta: (listener: (delta: string) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, delta: string): void => {
        listener(delta)
      }
      ipcRenderer.on('translator:delta', handler)
      return () => ipcRenderer.off('translator:delta', handler)
    },

    // Jotdowns
    listJotdowns: (): Promise<import('../shared/yachiyo/protocol').JotdownMeta[]> =>
      ipcRenderer.invoke('yachiyo:jotdown-list'),
    loadJotdown: (input: {
      id: string
    }): Promise<import('../shared/yachiyo/protocol').JotdownFull> =>
      ipcRenderer.invoke('yachiyo:jotdown-load', input),
    saveJotdown: (
      input: JotdownSaveInput
    ): Promise<import('../shared/yachiyo/protocol').JotdownMeta> =>
      ipcRenderer.invoke('yachiyo:jotdown-save', input),
    createJotdown: (): Promise<import('../shared/yachiyo/protocol').JotdownFull> =>
      ipcRenderer.invoke('yachiyo:jotdown-create'),
    deleteJotdown: (input: { id: string }): Promise<void> =>
      ipcRenderer.invoke('yachiyo:jotdown-delete', input),

    getConfig: () => ipcRenderer.invoke('yachiyo:get-config'),
    getSoulDocument: (): Promise<SoulDocument> => ipcRenderer.invoke('yachiyo:get-soul-document'),
    addSoulTrait: (input: { trait: string }): Promise<SoulDocument> =>
      ipcRenderer.invoke('yachiyo:add-soul-trait', input),
    deleteSoulTrait: (input: { trait: string }): Promise<SoulDocument> =>
      ipcRenderer.invoke('yachiyo:delete-soul-trait', input),
    getMemoryTermDocument: (input?: GetMemoryTermDocumentInput): Promise<MemoryTermDocument> =>
      ipcRenderer.invoke('yachiyo:get-memory-term-document', input),
    getUserDocument: (): Promise<UserDocument> => ipcRenderer.invoke('yachiyo:get-user-document'),
    testMemoryConnection: (input: TestMemoryConnectionInput) =>
      ipcRenderer.invoke('yachiyo:test-memory-connection', input),
    testSubagentProfile: (input: TestSubagentProfileInput) =>
      ipcRenderer.invoke('yachiyo:test-subagent-profile', input),
    getSettings: () => ipcRenderer.invoke('yachiyo:get-settings'),
    saveConfig: (input: SettingsConfig) => ipcRenderer.invoke('yachiyo:save-config', input),
    saveUserDocument: (input: { content: string }): Promise<UserDocument> =>
      ipcRenderer.invoke('yachiyo:save-user-document', input),
    saveSettings: (input: Partial<ProviderSettings>) =>
      ipcRenderer.invoke('yachiyo:save-settings', input),
    upsertProvider: (input: ProviderConfig) => ipcRenderer.invoke('yachiyo:upsert-provider', input),
    removeProvider: (input: { name: string }) =>
      ipcRenderer.invoke('yachiyo:remove-provider', input),
    enableProviderModel: (input: { name: string; model: string }) =>
      ipcRenderer.invoke('yachiyo:enable-provider-model', input),
    disableProviderModel: (input: { name: string; model: string }) =>
      ipcRenderer.invoke('yachiyo:disable-provider-model', input),
    fetchProviderModels: (input: ProviderConfig) =>
      ipcRenderer.invoke('yachiyo:fetch-provider-models', input),
    listSkills: (input?: ListSkillsInput) => ipcRenderer.invoke('yachiyo:list-skills', input),
    openSkillsFolder: () => ipcRenderer.invoke('yachiyo:open-skills-folder'),
    listWebSearchBrowserImportSources: () =>
      ipcRenderer.invoke('yachiyo:list-web-search-browser-import-sources'),
    importWebSearchBrowserSession: (input: ImportWebSearchBrowserSessionInput) =>
      ipcRenderer.invoke('yachiyo:import-web-search-browser-session', input),
    setThreadPrivacyMode: (input: { threadId: string; enabled: boolean }): Promise<ThreadRecord> =>
      ipcRenderer.invoke('yachiyo:set-thread-privacy-mode', input),
    setThreadModelOverride: (input: {
      threadId: string
      modelOverride: ThreadModelOverride | null
    }): Promise<ThreadRecord> => ipcRenderer.invoke('yachiyo:set-thread-model-override', input),
    setThreadRuntimeBinding: (input: {
      threadId: string
      runtimeBinding: ThreadRuntimeBinding | null
    }): Promise<ThreadRecord> => ipcRenderer.invoke('yachiyo:set-thread-runtime-binding', input),
    regenerateThreadTitle: (input: { threadId: string }): Promise<ThreadRecord> =>
      ipcRenderer.invoke('yachiyo:regenerate-thread-title', input),
    starThread: (input: { threadId: string; starred: boolean }): Promise<ThreadRecord> =>
      ipcRenderer.invoke('yachiyo:star-thread', input),
    readClipboardFilePaths: (): Promise<
      { filename: string; mediaType: string; dataUrl: string }[]
    > => ipcRenderer.invoke('yachiyo:read-clipboard-file-paths'),
    readAttachmentFile: (input: { filePath: string; mediaType: string }): Promise<string> =>
      ipcRenderer.invoke('yachiyo:read-attachment-file', input),
    listDiscoveredApps: (): Promise<{
      editors: { name: string; iconDataUrl?: string }[]
      terminals: { name: string; iconDataUrl?: string }[]
    }> => ipcRenderer.invoke('yachiyo:list-discovered-apps'),
    openWorkspaceWithApp: (input: { threadId: string; appName: string }): Promise<void> =>
      ipcRenderer.invoke('yachiyo:open-workspace-with-app', input),
    loadThreadData: (input: {
      threadId: string
    }): Promise<{
      messages: import('../shared/yachiyo/protocol').MessageRecord[]
      toolCalls: import('../shared/yachiyo/protocol').ToolCallRecord[]
    }> => ipcRenderer.invoke('yachiyo:load-thread-data', input),
    listExternalThreads: (): Promise<ThreadRecord[]> =>
      ipcRenderer.invoke('yachiyo:list-external-threads'),
    listChannelUsers: (): Promise<ChannelUserRecord[]> =>
      ipcRenderer.invoke('yachiyo:list-channel-users'),
    updateChannelUser: (input: UpdateChannelUserInput): Promise<ChannelUserRecord> =>
      ipcRenderer.invoke('yachiyo:update-channel-user', input),
    listChannelGroups: (): Promise<ChannelGroupRecord[]> =>
      ipcRenderer.invoke('yachiyo:list-channel-groups'),
    updateChannelGroup: (input: UpdateChannelGroupInput): Promise<ChannelGroupRecord> =>
      ipcRenderer.invoke('yachiyo:update-channel-group', input),
    clearGroupMonitorBuffer: (groupId: string): Promise<void> =>
      ipcRenderer.invoke('yachiyo:clear-group-monitor-buffer', { groupId }),
    getChannelsConfig: (): Promise<ChannelsConfig> =>
      ipcRenderer.invoke('yachiyo:get-channels-config'),
    saveChannelsConfig: (input: ChannelsConfig): Promise<ChannelsConfig> =>
      ipcRenderer.invoke('yachiyo:save-channels-config', input),

    // Schedules
    listSchedules: (): Promise<import('../shared/yachiyo/protocol').ScheduleRecord[]> =>
      ipcRenderer.invoke('yachiyo:list-schedules'),
    createSchedule: (
      input: import('../shared/yachiyo/protocol').CreateScheduleInput
    ): Promise<import('../shared/yachiyo/protocol').ScheduleRecord> =>
      ipcRenderer.invoke('yachiyo:create-schedule', input),
    updateSchedule: (
      input: import('../shared/yachiyo/protocol').UpdateScheduleInput
    ): Promise<import('../shared/yachiyo/protocol').ScheduleRecord> =>
      ipcRenderer.invoke('yachiyo:update-schedule', input),
    deleteSchedule: (input: { id: string }): Promise<void> =>
      ipcRenderer.invoke('yachiyo:delete-schedule', input),
    enableSchedule: (input: { id: string }): Promise<boolean> =>
      ipcRenderer.invoke('yachiyo:enable-schedule', input),
    disableSchedule: (input: {
      id: string
    }): Promise<import('../shared/yachiyo/protocol').ScheduleRecord> =>
      ipcRenderer.invoke('yachiyo:disable-schedule', input),
    listScheduleRuns: (input: {
      scheduleId: string
      limit?: number
    }): Promise<import('../shared/yachiyo/protocol').ScheduleRunRecord[]> =>
      ipcRenderer.invoke('yachiyo:list-schedule-runs', input),
    listRecentScheduleRuns: (input?: {
      limit?: number
    }): Promise<import('../shared/yachiyo/protocol').ScheduleRunRecord[]> =>
      ipcRenderer.invoke('yachiyo:list-recent-schedule-runs', input),
    markThreadAsRead: (input: {
      threadId: string
    }): Promise<import('../shared/yachiyo/protocol').ThreadRecord> =>
      ipcRenderer.invoke('yachiyo:mark-thread-as-read', input),

    showNotification: (input: { title: string; body?: string }): void =>
      ipcRenderer.send('yachiyo:show-notification', input),
    beep: (): void => ipcRenderer.send('yachiyo:beep'),
    subscribe: (listener: (event: YachiyoServerEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: YachiyoServerEvent): void => {
        listener(payload)
      }
      ipcRenderer.on('yachiyo:event', handler)
      return () => {
        ipcRenderer.off('yachiyo:event', handler)
      }
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
