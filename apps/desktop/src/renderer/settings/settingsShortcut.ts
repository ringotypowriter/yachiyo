import { hasExactPrimaryShortcutModifiers } from '../src/lib/platformShortcut.ts'

interface ShortcutEvent {
  altKey: boolean
  ctrlKey: boolean
  key: string
  metaKey: boolean
  shiftKey: boolean
}

export function isSaveSettingsShortcut(event: ShortcutEvent, platform: string): boolean {
  return hasExactPrimaryShortcutModifiers(event, platform) && event.key.toLowerCase() === 's'
}
