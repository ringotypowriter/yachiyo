import type { SettingsConfig } from '@yachiyo/shared/protocol'
import { resolvePlatformCapabilities } from '@yachiyo/shared/platformCapabilities'

export function preserveUnsupportedPlatformSettings(input: {
  platform: NodeJS.Platform
  previous: SettingsConfig
  submitted: SettingsConfig
}): SettingsConfig {
  const capabilities = resolvePlatformCapabilities(input.platform)
  if (capabilities.activityTracking && capabilities.keepAwake) {
    return input.submitted
  }

  const result: SettingsConfig = { ...input.submitted }
  const general = { ...input.submitted.general }

  if (!capabilities.activityTracking) {
    const previousActivityTracking = input.previous.general?.activityTracking
    if (previousActivityTracking) {
      general.activityTracking = previousActivityTracking
    } else {
      delete general.activityTracking
    }
  }

  if (!capabilities.keepAwake) {
    const previousPreventSystemSleep = input.previous.general?.preventSystemSleep
    if (previousPreventSystemSleep == null) {
      delete general.preventSystemSleep
    } else {
      general.preventSystemSleep = previousPreventSystemSleep
    }
  }

  if (Object.keys(general).length > 0) {
    result.general = general
  } else {
    delete result.general
  }

  return result
}
