import type { SettingsFieldResolutionMemory } from '../storage.ts'

export function parseSettingsFieldResolutions(
  value: string | undefined
): SettingsFieldResolutionMemory[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (item): item is SettingsFieldResolutionMemory =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as SettingsFieldResolutionMemory).path === 'string' &&
        typeof (item as SettingsFieldResolutionMemory).localFingerprint === 'string' &&
        typeof (item as SettingsFieldResolutionMemory).remoteFingerprint === 'string' &&
        ((item as SettingsFieldResolutionMemory).choice === 'local' ||
          (item as SettingsFieldResolutionMemory).choice === 'remote')
    )
  } catch {
    return []
  }
}
