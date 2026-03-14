import { useAppStore } from './store/useAppStore'

let started = false

export function bootstrapAppSession() {
  if (started) return
  started = true
  void useAppStore.getState().initialize()
}
