import { hasExactPrimaryShortcutModifiers } from '../../../lib/platformShortcut.ts'

interface ShortcutEvent {
  altKey: boolean
  ctrlKey: boolean
  key: string
  metaKey: boolean
  shiftKey: boolean
}

export function isOpenFindBarShortcut(event: ShortcutEvent, platform: string): boolean {
  return hasExactPrimaryShortcutModifiers(event, platform) && event.key.toLowerCase() === 'f'
}

export function isOpenSidebarSearchShortcut(event: ShortcutEvent, platform: string): boolean {
  return hasExactPrimaryShortcutModifiers(event, platform, true) && event.key.toLowerCase() === 'f'
}
