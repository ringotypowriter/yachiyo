import { useAppStore } from './store/useAppStore'

let started = false

export function bootstrapAppSession(): void {
  if (started) return
  started = true
  void useAppStore.getState().initialize()
}
