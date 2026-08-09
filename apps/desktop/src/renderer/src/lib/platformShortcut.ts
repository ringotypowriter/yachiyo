import { resolvePlatformCapabilities } from '@yachiyo/shared/platformCapabilities'

export interface ShortcutModifierState {
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

export function hasExactPrimaryShortcutModifiers(
  event: ShortcutModifierState,
  platform: string,
  shiftKey = false
): boolean {
  const usesMetaKey =
    resolvePlatformCapabilities(platform as NodeJS.Platform).primaryModifier === 'meta'

  return (
    !event.altKey &&
    event.ctrlKey === !usesMetaKey &&
    event.metaKey === usesMetaKey &&
    event.shiftKey === shiftKey
  )
}
