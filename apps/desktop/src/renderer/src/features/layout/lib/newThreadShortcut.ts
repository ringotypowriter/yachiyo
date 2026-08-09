import { hasExactPrimaryShortcutModifiers } from '../../../lib/platformShortcut.ts'

export interface NewThreadShortcutEvent {
  altKey: boolean
  ctrlKey: boolean
  key: string
  metaKey: boolean
  shiftKey: boolean
}

export function isCreateNewThreadShortcut(
  event: NewThreadShortcutEvent,
  platform: string
): boolean {
  return hasExactPrimaryShortcutModifiers(event, platform) && event.key.toLowerCase() === 'n'
}
