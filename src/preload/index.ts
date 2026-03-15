import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type {
  ProviderConfig,
  ProviderSettings,
  SettingsConfig,
  YachiyoServerEvent
} from '../shared/yachiyo/protocol'

const api = {
  openSettings: () => ipcRenderer.send('open-settings'),
  yachiyo: {
    archiveThread: (input: { threadId: string }) =>
      ipcRenderer.invoke('yachiyo:archive-thread', input),
    bootstrap: () => ipcRenderer.invoke('yachiyo:bootstrap'),
    createThread: () => ipcRenderer.invoke('yachiyo:create-thread'),
    renameThread: (input: { threadId: string; title: string }) =>
      ipcRenderer.invoke('yachiyo:rename-thread', input),
    sendChat: (input: { threadId: string; content: string }) =>
      ipcRenderer.invoke('yachiyo:send-chat', input),
    cancelRun: (input: { runId: string }) => ipcRenderer.invoke('yachiyo:cancel-run', input),
    getConfig: () => ipcRenderer.invoke('yachiyo:get-config'),
    getSettings: () => ipcRenderer.invoke('yachiyo:get-settings'),
    saveConfig: (input: SettingsConfig) => ipcRenderer.invoke('yachiyo:save-config', input),
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
