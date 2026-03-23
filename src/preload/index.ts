import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  CompactThreadInput,
  CompactThreadAccepted,
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
  ThreadSearchResult,
  UserDocument,
  ToolPreferencesInput,
  YachiyoServerEvent
} from '../shared/yachiyo/protocol'

const api = {
  openSettings: () => ipcRenderer.send('open-settings'),
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
    openThreadWorkspace: (input: { threadId: string }) =>
      ipcRenderer.invoke('yachiyo:open-thread-workspace', input),
    pickWorkspaceDirectory: () => ipcRenderer.invoke('yachiyo:pick-workspace-directory'),
    renameThread: (input: { threadId: string; title: string }) =>
      ipcRenderer.invoke('yachiyo:rename-thread', input),
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
    getUserDocument: (): Promise<UserDocument> => ipcRenderer.invoke('yachiyo:get-user-document'),
    testMemoryConnection: (input: TestMemoryConnectionInput) =>
      ipcRenderer.invoke('yachiyo:test-memory-connection', input),
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
