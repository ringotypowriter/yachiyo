// Desktop and headless builds replace this module with their emitted worker location.
export const pluginWorkerPath = new URL('./pluginWorker.ts', import.meta.url)
