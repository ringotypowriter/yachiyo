export interface BehaviorSettingVisibility {
  keepAwake: boolean
  launchAtLogin: boolean
}

export function resolveBehaviorSettingVisibility(platform: string): BehaviorSettingVisibility {
  const capabilities = resolvePlatformCapabilities(platform as NodeJS.Platform)
  return {
    keepAwake: capabilities.keepAwake,
    launchAtLogin: capabilities.launchAtLogin
  }
}
import { resolvePlatformCapabilities } from '@yachiyo/shared/platformCapabilities'
