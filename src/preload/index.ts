import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
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
  ThreadSearchResult,
  MemoryTermDocument,
  UserDocument,
  SoulDocument,
  ToolPreferencesInput,
  YachiyoServerEvent
} from '../shared/yachiyo/protocol'

const api = {
  openSettings: () => ipcRenderer.send('open-settings'),
  setVibrancy: (enabled: boolean) => ipcRenderer.send('set-vibrancy', enabled),
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
    createThread: (input?: { workspacePath?: string }) =>
      ipcRenderer.invoke('yachiyo:create-thread', input),
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
