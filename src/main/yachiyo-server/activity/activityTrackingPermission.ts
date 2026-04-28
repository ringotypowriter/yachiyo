import type { ActivityTrackingConfig, SettingsConfig } from '../../../shared/yachiyo/protocol.ts'

export interface ActivityTrackingPermissionDeps {
  platform: NodeJS.Platform
  requestAccessibilityTrust: () => boolean
  probeFullActivityAccess: () => Promise<boolean>
}

function deniedActivityTrackingConfig(currentConfig: SettingsConfig): ActivityTrackingConfig {
  const previousMode = currentConfig.general?.activityTracking?.mode
  return {
    mode: previousMode === 'off' ? 'off' : 'simple',
    accessibilityDenied: true
  }
}

export async function resolveActivityTrackingPermissionForSave(
  input: SettingsConfig,
  currentConfig: SettingsConfig,
  deps: ActivityTrackingPermissionDeps
): Promise<SettingsConfig> {
  if (input.general?.activityTracking?.mode !== 'full') {
    return input
  }

  if (deps.platform !== 'darwin') {
    return {
      ...input,
      general: {
        ...input.general,
        activityTracking: deniedActivityTrackingConfig(currentConfig)
      }
    }
  }

  const electronTrusted = deps.requestAccessibilityTrust()
  const fullSamplerAvailable = electronTrusted && (await deps.probeFullActivityAccess())

  return {
    ...input,
    general: {
      ...input.general,
      activityTracking: fullSamplerAvailable
        ? { mode: 'full' }
        : deniedActivityTrackingConfig(currentConfig)
    }
  }
}
